import * as path from "path";

const prepareInfoFileName = ".nsprepareinfo";

export interface IPrepareInfo {
	time: string;
	bundle: boolean;
	release: boolean;
}

export class ProjectChangesInfo implements IProjectChangesInfo {

	public get hasChanges(): boolean {
		return this.packageChanged || this.appFilesChanged || this.appResourcesChanged || this.modulesChanged || this.configChanged;
	}

	public get changesRequireBuild(): boolean {
		let change = this.packageChanged || this.appResourcesChanged || this.nativeChanged;
		return change;
	}

	public appFilesChanged: boolean = false;
	public appResourcesChanged: boolean = false;
	public modulesChanged: boolean = false;
	public configChanged: boolean = false;
	public prepareInfo: IPrepareInfo;
	public packageChanged: boolean = false;
	public nativeChanged: boolean = false;

	private newFiles: number = 0;

	constructor(platform: string,
		private force: boolean,
		private skipModulesAndResources: boolean,
		private $platformsData: IPlatformsData,
		private $projectData: IProjectData,
		private $devicePlatformsConstants: Mobile.IDevicePlatformsConstants,
		private $options: IOptions,
		private $fs: IFileSystem) {

			let platformData = this.$platformsData.getPlatformData(platform);
			let buildInfoFile = path.join(platformData.projectRoot, prepareInfoFileName);

			if (force || !this.$fs.exists(buildInfoFile).wait()) {
				this.appFilesChanged = true;
				this.appResourcesChanged = true;
				this.modulesChanged = true;
				this.configChanged = true;
				this.prepareInfo = { time: "", bundle: $options.bundle, release: $options.release };
			} else {
				let outputProjectMtime = this.$fs.getFsStats(buildInfoFile).wait().mtime.getTime();
				this.prepareInfo = this.$fs.readJson(buildInfoFile).wait();
				this.appFilesChanged = this.containsNewerFiles(this.$projectData.appDirectoryPath, this.$projectData.appResourcesDirectoryPath, outputProjectMtime);
				if (!skipModulesAndResources) {
					this.packageChanged = this.filesChanged([path.join(this.$projectData.projectDir, "package.json")], outputProjectMtime);
					this.appResourcesChanged = this.containsNewerFiles(this.$projectData.appResourcesDirectoryPath, null, outputProjectMtime);
					/*done because currently all node_modules are traversed, a possible improvement could be traversing only the production dependencies*/
					this.nativeChanged = this.containsNewerFiles(path.join(this.$projectData.projectDir, "node_modules"),
											path.join(this.$projectData.projectDir, "node_modules", "tns-ios-inspector"),
											outputProjectMtime, ProjectChangesInfo.fileChangeRequiresBuild);
					if (this.newFiles > 0) {
						this.modulesChanged = true;
					}
					let platformResourcesDir = path.join(this.$projectData.appResourcesDirectoryPath, platformData.normalizedPlatformName);
					if (platform === this.$devicePlatformsConstants.iOS.toLowerCase()) {
						this.configChanged = this.filesChanged([
							this.$options.baseConfig || path.join(platformResourcesDir, platformData.configurationFileName),
							path.join(platformResourcesDir, "LaunchScreen.storyboard"),
							path.join(platformResourcesDir, "build.xcconfig")
						], outputProjectMtime);
					} else {
						this.configChanged = this.filesChanged([
							path.join(platformResourcesDir, platformData.configurationFileName),
							path.join(platformResourcesDir, "app.gradle")
						], outputProjectMtime);
					}
				}

				if (this.$options.bundle !== this.prepareInfo.bundle || this.$options.release !== this.prepareInfo.release) {
					this.appFilesChanged = true;
					this.appResourcesChanged = true;
					this.modulesChanged = true;
					this.configChanged = true;
					this.prepareInfo.release = this.$options.release;
					this.prepareInfo.bundle = this.$options.bundle;
				}
				if (this.packageChanged) {
					this.modulesChanged = true;
				}
				if (this.modulesChanged || this.appResourcesChanged) {
					this.configChanged = true;
				}
			}

			if (this.hasChanges) {
				this.prepareInfo.time = new Date().toString();
				this.$fs.writeJson(buildInfoFile, this.prepareInfo).wait();
			}
	}

	private filesChanged(files: string[], mtime: number): boolean {
		for (let file of files) {
			if (this.$fs.exists(file).wait()) {
				let fileStats = this.$fs.getFsStats(file).wait();
				if (fileStats.mtime.getTime() > mtime) {
					return true;
				}
			}
		}
		return false;
	}

	private containsNewerFiles(dir: string, skipDir: string, mtime: number, processFunc?: (filePath: string, projectDir: string, fs: IFileSystem) => boolean): boolean {
		let files = this.$fs.readDirectory(dir).wait();
		for (let file of files) {
			let filePath = path.join(dir, file);
			if (filePath === skipDir) {
				continue;
			}
			let fileStats = this.$fs.getFsStats(filePath).wait();
			let changed = fileStats.mtime.getTime() > mtime;
			if (!changed) {
				let lFileStats = this.$fs.getLsStats(filePath).wait();
				changed = lFileStats.mtime.getTime() > mtime;
			}
			if (changed) {
				if (processFunc) {
					this.newFiles ++;
					let filePathRelative = path.relative(this.$projectData.projectDir, filePath);
					if (processFunc(filePathRelative, this.$projectData.projectDir, this.$fs)) {
						return true;
					}
				} else {
					return true;
				}
			}
			if (fileStats.isDirectory()) {
				if (this.containsNewerFiles(filePath, skipDir, mtime, processFunc)) {
					return true;
				}
			}
		}
		return false;
	}

	static fileChangeRequiresBuild(file: string, projectDir: string, fs: IFileSystem) {
		if (path.basename(file) === "package.json") {
			return true;
		}
		if (_.startsWith(file, "node_modules")) {
			if (!_.startsWith(file, path.join("node_modules", "tns-core-modules"))) {
				let filePath = file;
				while(filePath !== "node_modules") {
					filePath = path.dirname(filePath);
					let fullFilePath = path.join(projectDir, path.join(filePath, "package.json"));
					if (fs.exists(fullFilePath).wait()) {
						let json = fs.readJson(fullFilePath).wait();
						if (json["nativescript"] && _.startsWith(file, path.join(filePath, "platforms"))) {
							return true;
						}
					}
				}
			}
		}
		return false;
	}

	static getLatestPrepareInfo(platformData: IPlatformData, fs: IFileSystem): IPrepareInfo {
		let prepareInfoFile = path.join(platformData.projectRoot, prepareInfoFileName);
		if (fs.exists(prepareInfoFile).wait()) {
			let prepareInfo = fs.readJson(prepareInfoFile).wait();
			return prepareInfo;
		}
		return null;
	}
}
