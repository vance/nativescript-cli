import syncBatchLib = require("../../common/services/livesync/sync-batch");
import * as shell from "shelljs";
import * as path from "path";
import * as temp from "temp";
import * as minimatch from "minimatch";
import * as constants from "../../common/constants";
import * as util from "util";
import {ProjectChangesInfo,IPrepareInfo} from "../project-changes-info";
import * as shelljs from "shelljs";

const livesyncInfoFileName = ".nslivesyncinfo";

export abstract class PlatformLiveSyncServiceBase implements IPlatformLiveSyncService {
	private showFullLiveSyncInformation: boolean = false;
	private fileHashes: IDictionary<string>;
	private batch: IDictionary<ISyncBatch> = Object.create(null);
	private livesyncData: IDictionary<ILiveSyncData> = Object.create(null);

	protected liveSyncData: ILiveSyncData;

	constructor(_liveSyncData: ILiveSyncData,
		protected $devicesService: Mobile.IDevicesService,
		protected $mobileHelper: Mobile.IMobileHelper,
		protected $logger: ILogger,
		protected $options: IOptions,
		protected $deviceAppDataFactory: Mobile.IDeviceAppDataFactory,
		protected $fs: IFileSystem,
		protected $injector: IInjector,
		protected $projectFilesManager: IProjectFilesManager,
		protected $projectFilesProvider: IProjectFilesProvider,
		protected $platformService: IPlatformService,
		protected $platformsData: IPlatformsData,
		protected $devicePlatformsConstants: Mobile.IDevicePlatformsConstants,
		protected $projectData: IProjectData,
		protected $liveSyncProvider: ILiveSyncProvider) {
		this.liveSyncData = _liveSyncData;
		this.fileHashes = Object.create(null);
	}

	public fullSync(postAction?: (deviceAppData: Mobile.IDeviceAppData, localToDevicePaths: Mobile.ILocalToDevicePathData[]) => IFuture<void>): IFuture<void> {
		return (() => {
			let appIdentifier = this.liveSyncData.appIdentifier;
			let platform = this.liveSyncData.platform;
			let projectFilesPath = this.liveSyncData.projectFilesPath;
			let canExecute = this.getCanExecuteAction(platform, appIdentifier);
			let action = (device: Mobile.IDevice): IFuture<void> => {
				return (() => {
					this.deploy(device);
					let deviceAppData = this.$deviceAppDataFactory.create(appIdentifier, this.$mobileHelper.normalizePlatformName(platform), device);
					let localToDevicePaths = this.$projectFilesManager.createLocalToDevicePaths(deviceAppData, projectFilesPath, null, this.liveSyncData.excludedProjectDirsAndFiles);
					this.transferFiles(deviceAppData, localToDevicePaths, this.liveSyncData.projectFilesPath, true).wait();

					if (postAction) {
						this.finishLivesync(deviceAppData).wait();
						return postAction(deviceAppData, localToDevicePaths).wait();
					}

					// let filePath = "/Users/raikov/test.txt";
					// let syncFileData = this.$projectFilesManager.createLocalToDevicePaths(deviceAppData, projectFilesPath, [filePath], null);
					// let deviceFilePath = path.join(syncFileData[0].deviceProjectRootPath, path.basename(filePath));
					// device.fileSystem.putFile(filePath, deviceFilePath).wait();
					// let text = this.readFile(device, deviceFilePath).wait();

					this.refreshApplication(deviceAppData, localToDevicePaths).wait();
					this.finishLivesync(deviceAppData).wait();
				}).future<void>()();
			};
			this.$devicesService.execute(action, canExecute).wait();
		}).future<void>()();
	}

	private readFile(device: Mobile.IDevice, deviceFilePath: string): IFuture<string> {
		return (() => {
			let fileName = path.basename(deviceFilePath);
			let uniqueFilePath = path.join(shelljs.tempdir(), this.$fs.getUniqueFileName(fileName));
			let devicePath = path.dirname(deviceFilePath);
			device.fileSystem.getFile(deviceFilePath, uniqueFilePath).wait();
			let text = this.$fs.readText(uniqueFilePath);
			shelljs.rm(uniqueFilePath);
			return text;
		}).future<string>()();
	}

	public partialSync(event: string, filePath: string, dispatcher: IFutureDispatcher, afterFileSyncAction: (deviceAppData: Mobile.IDeviceAppData, localToDevicePaths: Mobile.ILocalToDevicePathData[]) => IFuture<void>): void {
		if (filePath.indexOf(constants.APP_RESOURCES_FOLDER_NAME) !== -1) {
			this.$logger.warn(`Skipping livesync for changed file ${filePath}. This change requires a full build to update your application. `.yellow.bold);
			return;
		}

		let fileHash = this.$fs.exists(filePath) && this.$fs.getFsStats(filePath).isFile() ? this.$fs.getFileShasum(filePath).wait() : "";
		if (fileHash === this.fileHashes[filePath]) {
			this.$logger.trace(`Skipping livesync for ${filePath} file with ${fileHash} hash.`);
			return;
		}

		this.$logger.trace(`Adding ${filePath} file with ${fileHash} hash.`);
		this.fileHashes[filePath] = fileHash;

		if (this.isFileExcluded(filePath, this.liveSyncData.excludedProjectDirsAndFiles)) {
			this.$logger.trace(`Skipping livesync for changed file ${filePath} as it is excluded in the patterns: ${this.liveSyncData.excludedProjectDirsAndFiles.join(", ")}`);
			return;
		}

		if (event === "add" || event === "change") {
			this.batchSync(filePath, dispatcher, afterFileSyncAction);
		} else if (event === "unlink") {
			this.fileHashes = <any>(_.omit(this.fileHashes, filePath));
			this.syncRemovedFile(filePath, afterFileSyncAction).wait();
		}
	}

	protected getCanExecuteAction(platform: string, appIdentifier: string): (dev: Mobile.IDevice) => boolean {
		let isTheSamePlatformAction = ((device: Mobile.IDevice) => device.deviceInfo.platform.toLowerCase() === platform.toLowerCase());
		if (this.$options.device) {
			return (device: Mobile.IDevice): boolean => isTheSamePlatformAction(device) && device.deviceInfo.identifier === this.$devicesService.getDeviceByDeviceOption().deviceInfo.identifier;
		}
		return isTheSamePlatformAction;
	}

	public refreshApplication(deviceAppData: Mobile.IDeviceAppData, localToDevicePaths: Mobile.ILocalToDevicePathData[]): IFuture<void> {
		return (() => {
			let deviceLiveSyncService = this.resolveDeviceSpecificLiveSyncService(deviceAppData.device.deviceInfo.platform, deviceAppData.device);
			this.$logger.info("Applying changes...");
			deviceLiveSyncService.refreshApplication(deviceAppData, localToDevicePaths, localToDevicePaths === null).wait();
		}).future<void>()();
	}

	protected finishLivesync(deviceAppData: Mobile.IDeviceAppData): IFuture<void> {
		return (() => {
			// This message is important because it signals Visual Studio Code that livesync has finished and debugger can be attached.
			this.$logger.info(`Successfully synced application ${deviceAppData.appIdentifier} on device ${deviceAppData.device.deviceInfo.identifier}.`);
		}).future<void>()();
	}

	protected transferFiles(deviceAppData: Mobile.IDeviceAppData, localToDevicePaths: Mobile.ILocalToDevicePathData[], projectFilesPath: string, isFullSync: boolean): IFuture<void> {
		return (() => {
			this.$logger.info("Transferring project files...");
			let canTransferDirectory = isFullSync && (this.$devicesService.isAndroidDevice(deviceAppData.device) || this.$devicesService.isiOSSimulator(deviceAppData.device));
			if (canTransferDirectory) {
				deviceAppData.device.fileSystem.transferDirectory(deviceAppData, localToDevicePaths, projectFilesPath).wait();
			} else {
				this.$liveSyncProvider.transferFiles(deviceAppData, localToDevicePaths, projectFilesPath, isFullSync).wait();
			}
			if (localToDevicePaths && localToDevicePaths.length < 10) {
				for (let filePath of localToDevicePaths) {
					let fileName = path.basename(filePath.getLocalPath());
					this.$logger.info(`Successfully transferred ${fileName}.`);
				}
			} else {
				this.$logger.info("Successfully transferred all files.");
			}
		}).future<void>()();
	}

	protected resolveDeviceSpecificLiveSyncService(platform: string, device: Mobile.IDevice): IDeviceLiveSyncService {
		return this.$injector.resolve(this.$liveSyncProvider.deviceSpecificLiveSyncServices[platform.toLowerCase()], { _device: device });
	}

	private isFileExcluded(filePath: string, excludedPatterns: string[]): boolean {
		let isFileExcluded = false;
		_.each(excludedPatterns, pattern => {
			if (minimatch(filePath, pattern, { nocase: true })) {
				isFileExcluded = true;
				return false;
			}
		});

		return isFileExcluded;
	}

	private batchSync(filePath: string, dispatcher: IFutureDispatcher, afterFileSyncAction: (deviceAppData: Mobile.IDeviceAppData, localToDevicePaths: Mobile.ILocalToDevicePathData[]) => IFuture<void>): void {
		let platformBatch: ISyncBatch = this.batch[this.liveSyncData.platform];
		if (!platformBatch || !platformBatch.syncPending) {
			let done = () => {
				return (() => {
					dispatcher.dispatch(() => (() => {
						try {
							for (let platform in this.batch) {
								let batch = this.batch[platform];
								batch.syncFiles(((filesToSync:string[]) => {
									this.$platformService.preparePlatform(this.liveSyncData.platform).wait();
									let canExecute = this.getCanExecuteAction(this.liveSyncData.platform, this.liveSyncData.appIdentifier);
									let deviceFileAction = (deviceAppData: Mobile.IDeviceAppData, localToDevicePaths: Mobile.ILocalToDevicePathData[]) => this.transferFiles(deviceAppData, localToDevicePaths, this.liveSyncData.projectFilesPath, !filePath);
									let action = this.getSyncAction(filesToSync, deviceFileAction, afterFileSyncAction);
									this.$devicesService.execute(action, canExecute).wait();
								}).future<void>()).wait();
							}
						} catch (err) {
						 	this.$logger.warn(`Unable to sync files. Error is:`, err.message);
						}
					}).future<void>()());
				}).future<void>()();
			};
			this.batch[this.liveSyncData.platform] = this.$injector.resolve(syncBatchLib.SyncBatch, { done: done });
			this.livesyncData[this.liveSyncData.platform] = this.liveSyncData;
		}

		this.batch[this.liveSyncData.platform].addFile(filePath);
	}

	private syncRemovedFile(filePath: string, afterFileSyncAction: (deviceAppData: Mobile.IDeviceAppData, localToDevicePaths: Mobile.ILocalToDevicePathData[]) => IFuture<void>): IFuture<void> {
		return (() => {
			let deviceFilesAction = (deviceAppData: Mobile.IDeviceAppData, localToDevicePaths: Mobile.ILocalToDevicePathData[]) => {
				let deviceLiveSyncService = this.resolveDeviceSpecificLiveSyncService(this.liveSyncData.platform, deviceAppData.device);
				return deviceLiveSyncService.removeFiles(this.liveSyncData.appIdentifier, localToDevicePaths);
			};
			let canExecute = this.getCanExecuteAction(this.liveSyncData.platform, this.liveSyncData.appIdentifier);
			let action = this.getSyncAction([filePath], deviceFilesAction, afterFileSyncAction);
			this.$devicesService.execute(action, canExecute).wait();
		}).future<void>()();
	}

	private getSyncAction(filesToSync: string[],
		fileSyncAction: (deviceAppData: Mobile.IDeviceAppData, localToDevicePaths: Mobile.ILocalToDevicePathData[]) => IFuture<void>,
		afterFileSyncAction: (deviceAppData: Mobile.IDeviceAppData, localToDevicePaths: Mobile.ILocalToDevicePathData[]) => IFuture<void>): (device: Mobile.IDevice) => IFuture<void> {
		let action = (device: Mobile.IDevice): IFuture<void> => {
			return (() => {
				let deviceAppData = this.$deviceAppDataFactory.create(this.liveSyncData.appIdentifier, this.$mobileHelper.normalizePlatformName(this.liveSyncData.platform), device);
				if (this.changeRequiresDeploy(filesToSync)) {
					this.deploy(device);
					this.refreshApplication(deviceAppData, null).wait();
				} else {
					let mappedFiles = filesToSync.map((file: string) => this.$projectFilesProvider.mapFilePath(file, device.deviceInfo.platform));
					let localToDevicePaths = this.$projectFilesManager.createLocalToDevicePaths(deviceAppData, this.liveSyncData.projectFilesPath, mappedFiles, this.liveSyncData.excludedProjectDirsAndFiles);
					fileSyncAction(deviceAppData, localToDevicePaths).wait();
					if (!afterFileSyncAction) {
						this.refreshApplication(deviceAppData, localToDevicePaths).wait();
					}
					this.finishLivesync(deviceAppData).wait();
					if (afterFileSyncAction) {
						afterFileSyncAction(deviceAppData, localToDevicePaths).wait();
					}
					let platformData = this.$platformsData.getPlatformData(device.deviceInfo.platform);
					this.saveLivesyncInfo(device, platformData);
				}
			}).future<void>()();
		};
		return action;
	}

	protected deploy(device: Mobile.IDevice) {
		this.$logger.info("Installing...");
		let platformData = this.$platformsData.getPlatformData(device.deviceInfo.platform);
		if (this.shouldBuildWhenLivesyncing(device, platformData)) {
			this.$platformService.buildPlatform(this.liveSyncData.platform, { buildForDevice: !device.isEmulator }).wait();
		}
		device.applicationManager.checkForApplicationUpdates().wait();
		let appIdentifier = this.liveSyncData.appIdentifier;
		if (device.applicationManager.isApplicationInstalled(appIdentifier).wait()) {
			device.applicationManager.stopApplication(appIdentifier).wait();
			device.applicationManager.uninstallApplication(appIdentifier).wait();
		}
		let packageFilePath = "";
		if (device.isEmulator) {
			packageFilePath = this.$platformService.getLatestApplicationPackageForEmulator(platformData).packageName;
		} else {
			packageFilePath = this.$platformService.getLatestApplicationPackageForDevice(platformData).packageName;
		}
		device.applicationManager.installApplication(packageFilePath).wait();
		this.$logger.info(`Successfully installed on device with identifier '${device.deviceInfo.identifier}'.`);
		this.saveLivesyncInfo(device, platformData);
	}

	private changeRequiresDeploy(filesToSync: string[]): boolean {
		let projectDir = this.$projectData.projectDir;
		for (let file of filesToSync) {
			if (ProjectChangesInfo.fileChangeRequiresBuild(file, projectDir, this.$fs)) {
				return true;
			}
		}
		return false;
	}

	protected shouldBuildWhenLivesyncing(device: Mobile.IDevice, platformData: IPlatformData): boolean {
		let prepareInfo = ProjectChangesInfo.getLatestPrepareInfo(platformData, this.$fs);
		let buildTime = this.$platformService.getLatestBuildTime(platformData.normalizedPlatformName.toLowerCase(), platformData, { buildForDevice: !device.isEmulator });
		if (prepareInfo.time !== buildTime) {
			let livesyncInfoFile = this.getLivesyncInfoFilePath(device);
			if (this.$fs.exists(livesyncInfoFile)) {
				let livesyncTime = this.$fs.readText(livesyncInfoFile);
				return prepareInfo.time !== livesyncTime && this.$platformService.getLatestChangesInfo().changesRequireBuild;
			}
			return this.$platformService.getLatestChangesInfo().changesRequireBuild;
		}
		return false;
	}

	protected saveLivesyncInfo(device: Mobile.IDevice, platformData: IPlatformData): void {
		let prepareInfo = ProjectChangesInfo.getLatestPrepareInfo(platformData, this.$fs);
		let livesyncInfoFile = this.getLivesyncInfoFilePath(device);
		this.$fs.writeFile(livesyncInfoFile, prepareInfo.time);
	}

	private getLivesyncInfoFilePath(device: Mobile.IDevice): string {
		let platform = device.deviceInfo.platform;
		let platformData = this.$platformsData.getPlatformData(platform);
		let livesyncInfoFilePath = platformData.deviceBuildOutputPath;
		if (platform.toLowerCase() === this.$devicePlatformsConstants.iOS.toLowerCase() && device.isEmulator) {
		 	livesyncInfoFilePath = platformData.emulatorBuildOutputPath;
		}
		let livesyncInfoFile = path.join(livesyncInfoFilePath, livesyncInfoFileName);
		return livesyncInfoFile;
	}
}
$injector.register("platformLiveSyncService", PlatformLiveSyncServiceBase);