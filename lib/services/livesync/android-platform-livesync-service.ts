import {PlatformLiveSyncServiceBase} from "./platform-livesync-service-base";

class AndroidPlatformLiveSyncService extends PlatformLiveSyncServiceBase {
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
		super(_liveSyncData, $devicesService, $mobileHelper, $logger, $options, $deviceAppDataFactory, $fs, $injector, $projectFilesManager, $projectFilesProvider, $platformService, $platformsData, $devicePlatformsConstants, $projectData, $liveSyncProvider);
	}

	public fullSync(postAction?: (deviceAppData: Mobile.IDeviceAppData, localToDevicePaths: Mobile.ILocalToDevicePathData[]) => IFuture<void>): IFuture<void> {
		return (() => {
			let appIdentifier = this.liveSyncData.appIdentifier;
			let platform = this.liveSyncData.platform;
			let projectFilesPath = this.liveSyncData.projectFilesPath;
			let canExecute = this.getCanExecuteAction(platform, appIdentifier);
			let action = (device: Mobile.IDevice): IFuture<void> => {
				return (() => {
					let deviceAppData = this.$deviceAppDataFactory.create(appIdentifier, this.$mobileHelper.normalizePlatformName(platform), device);
					let deviceLiveSyncService = this.resolveDeviceSpecificLiveSyncService(platform, device);
					if (deviceLiveSyncService.beforeLiveSyncAction) {
						deviceLiveSyncService.beforeLiveSyncAction(deviceAppData).wait();;
					}
					this.deploy(device);
					let localToDevicePaths = this.$projectFilesManager.createLocalToDevicePaths(deviceAppData, projectFilesPath, null, this.liveSyncData.excludedProjectDirsAndFiles);
					if (deviceLiveSyncService.afterInstallApplicationAction) {
						deviceLiveSyncService.afterInstallApplicationAction(deviceAppData, localToDevicePaths).wait();
					}
					this.transferFiles(deviceAppData, localToDevicePaths, this.liveSyncData.projectFilesPath, true).wait();

					if (postAction) {
						this.finishLivesync(deviceAppData).wait();
						return postAction(deviceAppData, localToDevicePaths).wait();
					}

					this.refreshApplication(deviceAppData, localToDevicePaths).wait();
					this.finishLivesync(deviceAppData).wait();
				}).future<void>()();
			};
			this.$devicesService.execute(action, canExecute).wait();
		}).future<void>()();
	}
}

$injector.register("androidPlatformLiveSyncServiceLocator", {factory: AndroidPlatformLiveSyncService});
