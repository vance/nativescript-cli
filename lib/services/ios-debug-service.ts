import * as iOSDevice from "../common/mobile/ios/device/ios-device";
import * as net from "net";
import * as path from "path";
import * as log4js from "log4js";
import { ChildProcess } from "child_process";
import { exportedPromise } from "../common/decorators";

import byline = require("byline");

const inspectorBackendPort = 18181;
const inspectorAppName = "NativeScript Inspector.app";
const inspectorNpmPackageName = "tns-ios-inspector";
const inspectorUiDir = "WebInspectorUI/";
const TIMEOUT_SECONDS = 9;

class IOSDebugService implements IDebugService {
	private _lldbProcess: ChildProcess;
	private _sockets: net.Socket[] = [];
	private _childProcess: ChildProcess;
	private _socketProxy: any;

	constructor(private $platformService: IPlatformService,
		private $iOSEmulatorServices: Mobile.IEmulatorPlatformServices,
		private $devicesService: Mobile.IDevicesService,
		private $platformsData: IPlatformsData,
		private $childProcess: IChildProcess,
		private $logger: ILogger,
		private $errors: IErrors,
		private $npmInstallationManager: INpmInstallationManager,
		private $iOSNotification: IiOSNotification,
		private $iOSSocketRequestExecutor: IiOSSocketRequestExecutor,
		private $processService: IProcessService,
		private $socketProxyFactory: ISocketProxyFactory) {
		this.$processService.attachToProcessExitSignals(this, this.debugStop);
	}

	public get platform(): string {
		return "ios";
	}

	public async debug(projectData: IProjectData, debugOptions: IDebugOptions): Promise<string> {
		if (debugOptions.debugBrk && debugOptions.start) {
			this.$errors.failWithoutHelp("Expected exactly one of the --debug-brk or --start options.");
		}

		if (this.$devicesService.isOnlyiOSSimultorRunning() || this.$devicesService.deviceCount === 0) {
			debugOptions.emulator = true;
		}

		if (debugOptions.emulator) {
			if (debugOptions.debugBrk) {
				return this.emulatorDebugBrk(projectData, true, debugOptions);
			} else if (debugOptions.start) {
				return this.emulatorStart(projectData, debugOptions);
			} else {
				return this.emulatorDebugBrk(projectData, false, debugOptions);
			}
		} else {
			if (debugOptions.debugBrk) {
				return this.deviceDebugBrk(projectData, true, debugOptions);
			} else if (debugOptions.start) {
				return this.deviceStart(projectData, debugOptions);
			} else {
				return this.deviceDebugBrk(projectData, false, debugOptions);
			}
		}
	}

	public async debugStart(projectData: IProjectData, debugOptions: IDebugOptions): Promise<void> {
		await this.$devicesService.initialize({ platform: this.platform, deviceId: debugOptions.device });
		await this.$devicesService.execute(async (device: Mobile.IiOSDevice) => await device.isEmulator ? this.emulatorDebugBrk(projectData, false, debugOptions) : this.debugBrkCore(device, projectData, debugOptions));
	}

	public async debugStop(): Promise<void> {
		if (this._socketProxy) {
			this._socketProxy.close();
			this._socketProxy = null;
		}

		_.forEach(this._sockets, socket => socket.destroy());
		this._sockets = [];

		if (this._lldbProcess) {
			this._lldbProcess.stdin.write("process detach\n");
			this._lldbProcess.kill();
			this._lldbProcess = undefined;
		}

		if (this._childProcess) {
			this._childProcess.kill();
			this._childProcess = undefined;
		}
	}

	private async emulatorDebugBrk(projectData: IProjectData, shouldBreak: boolean, debugOptions: IDebugOptions): Promise<string> {
		let platformData = this.$platformsData.getPlatformData(this.platform, projectData);

		let emulatorPackage = this.$platformService.getLatestApplicationPackageForEmulator(platformData);

		let args = shouldBreak ? "--nativescript-debug-brk" : "--nativescript-debug-start";
		let child_process = await this.$iOSEmulatorServices.runApplicationOnEmulator(emulatorPackage.packageName, {
			waitForDebugger: true, captureStdin: true,
			args: args, appId: projectData.projectId,
			skipInstall: true
		});

		let lineStream = byline(child_process.stdout);
		this._childProcess = child_process;

		lineStream.on('data', (line: NodeBuffer) => {
			let lineText = line.toString();
			if (lineText && _.startsWith(lineText, projectData.projectId)) {
				let pid = _.trimStart(lineText, projectData.projectId + ": ");
				this._lldbProcess = this.$childProcess.spawn("lldb", ["-p", pid]);
				if (log4js.levels.TRACE.isGreaterThanOrEqualTo(this.$logger.getLevel())) {
					this._lldbProcess.stdout.pipe(process.stdout);
				}
				this._lldbProcess.stderr.pipe(process.stderr);
				this._lldbProcess.stdin.write("process continue\n");
			} else {
				process.stdout.write(line + "\n");
			}
		});

		return this.wireDebuggerClient(projectData, debugOptions);
	}

	private async emulatorStart(projectData: IProjectData, debugOptions: IDebugOptions): Promise<string> {
		const result = await this.wireDebuggerClient(projectData, debugOptions);

		let attachRequestMessage = this.$iOSNotification.getAttachRequest(projectData.projectId);

		let iOSEmulator = <Mobile.IiOSSimulatorService>this.$iOSEmulatorServices;
		await iOSEmulator.postDarwinNotification(attachRequestMessage);
		return result;
	}

	private async deviceDebugBrk(projectData: IProjectData, shouldBreak: boolean, debugOptions: IDebugOptions): Promise<string> {
		await this.$devicesService.initialize({ platform: this.platform, deviceId: debugOptions.device });
		return this.$devicesService.execute(async (device: iOSDevice.IOSDevice) => {
			if (device.isEmulator) {
				return await this.emulatorDebugBrk(projectData, shouldBreak, debugOptions);
			}

			const runOptions: IRunPlatformOptions = {
				device: debugOptions.device,
				emulator: debugOptions.emulator,
				justlaunch: debugOptions.justlaunch
			};
			// we intentionally do not wait on this here, because if we did, we'd miss the AppLaunching notification
			let action = this.$platformService.startApplication(this.platform, runOptions, projectData);

			const result = await this.debugBrkCore(device, projectData, shouldBreak);

			await action;

			return result;
		});
	}

	private async debugBrkCore(device: Mobile.IiOSDevice, projectData: IProjectData, debugOptions: IDebugOptions, shouldBreak?: boolean): Promise<string> {
		await this.$iOSSocketRequestExecutor.executeLaunchRequest(device.deviceInfo.identifier, TIMEOUT_SECONDS, TIMEOUT_SECONDS, projectData.projectId, shouldBreak);
		return this.wireDebuggerClient(projectData, debugOptions, device);
	}

	private async deviceStart(projectData: IProjectData, debugOptions: IDebugOptions): Promise<string> {
		await this.$devicesService.initialize({ platform: this.platform, deviceId: debugOptions.device });
		return this.$devicesService.execute(async (device: Mobile.IiOSDevice) => device.isEmulator ? await this.emulatorStart(projectData, debugOptions) : await this.deviceStartCore(device, projectData, debugOptions));
	}

	private async deviceStartCore(device: Mobile.IiOSDevice, projectData: IProjectData, debugOptions: IDebugOptions): Promise<string> {
		await this.$iOSSocketRequestExecutor.executeAttachRequest(device, TIMEOUT_SECONDS, projectData.projectId);
		return this.wireDebuggerClient(projectData, debugOptions, device);
	}

	private async wireDebuggerClient(projectData: IProjectData, debugOptions: IDebugOptions, device?: Mobile.IiOSDevice): Promise<string> {
		if (debugOptions.chrome) {
			return this.createChromeDevToolsProxy(device);
		} else {
			this._socketProxy = this.$socketProxyFactory.createTCPSocketProxy(this.getSocketFactory(device));
			await this.openAppInspector(this._socketProxy.address(), projectData, debugOptions);
			return null;
		}
	}

	private async openAppInspector(fileDescriptor: string, projectData: IProjectData, debugOptions: IDebugOptions): Promise<void> {
		if (debugOptions.client) {
			let inspectorPath = await this.$npmInstallationManager.getInspectorFromCache(inspectorNpmPackageName, projectData.projectDir);

			let inspectorSourceLocation = path.join(inspectorPath, inspectorUiDir, "Main.html");
			let inspectorApplicationPath = path.join(inspectorPath, inspectorAppName);

			let cmd = `open -a '${inspectorApplicationPath}' --args '${inspectorSourceLocation}' '${projectData.projectName}' '${fileDescriptor}'`;
			await this.$childProcess.exec(cmd);
		} else {
			this.$logger.info("Suppressing debugging client.");
		}
	}

	private getSocketFactory(device?: Mobile.IiOSDevice): () => Promise<net.Socket> {
		const factory = async () => {
			const socket = device ? await device.connectToPort(inspectorBackendPort) : net.connect(inspectorBackendPort);
			this._sockets.push(socket);
			return socket;
		};

		factory.bind(this);
		return factory;
	}

	private createChromeDevToolsProxy(device: Mobile.IiOSDevice): string {
		this._socketProxy = this.$socketProxyFactory.createWebSocketProxy(this.getSocketFactory(device));

		const commitSHA = "02e6bde1bbe34e43b309d4ef774b1168d25fd024"; // corresponds to 55.0.2883 Chrome version
		return `chrome-devtools://devtools/remote/serve_file/@${commitSHA}/inspector.html?experiments=true&ws=localhost:${this._socketProxy.options.port}`;
	}
}

$injector.register("iOSDebugService", IOSDebugService);
