import { join, sep, basename, extname } from "path";
import * as semver from "semver";

export class Project implements IProject {

    public source: Project.Source;

    constructor(public path: string,
        public $fs: IFileSystem,
        public $logger: ILogger) {

        this.$logger.trace("Project at: " + this.path);
    }

    public rebuild(platform: string): IFuture<IProjectBuildResult> {
        return (() =>  {
            this.$logger.info("Project rebuild " + platform + " ...");
            let projectBuildResult: IProjectBuildResult;

            this.track("rebuild", () => {

                this.source = new Project.Source(this, ["ios", "android"], this.$fs, this.$logger);

                let platforms = {
                    ios: new Project.Target.IOS(this, this.$fs, this.$logger),
                    android: new Project.Target.Android(this, this.$fs, this.$logger)
                };

                // Populate the project build result... per platform...
                switch(platform) {
                    case "ios":
                        platforms.ios.rebuild();
                        projectBuildResult = platforms.ios.projectBuildResult;
                        break;
                    case "android":
                        platforms.android.rebuild();
                        projectBuildResult = platforms.android.projectBuildResult;
                        break;
                }

                // TODO: Provide platform outside
                projectBuildResult = platforms.ios.projectBuildResult;
            });

            this.$logger.info("Project rebuild " + platform + " ✔");
            return projectBuildResult;
        }).future<IProjectBuildResult>()();
    }

    public track<T>(label: string, task: () => T): T {
        this.$logger.trace(label + " ...");
        let result = task();
        if (result instanceof Promise) {
            (<any>result).then(() => this.$logger.trace(label + " ✔"));
        } else {
            this.$logger.trace(label + " ✔");
        }
        return result;
    }
}
$injector.register("project", Project);

export namespace Project {
    export namespace Package {
        export interface IJson {
            name?: string;
            version?: string;
            dependencies?: { [key: string]: string };
            devDependencies?: { [key: string]: string };
            nativescript: {
                id: string;
                platforms: { [platform: string]: string }; /* version */
            };
        }
        export const enum Type {
            App,
            Package,
            Nested
        }

        export const enum Availability {
            Available,
            NotInstalled,
            ShadowedByAncestor,
            ShadowedByDiverged
        }
    }

    export interface IPackage {
        type: Package.Type;
        name: string;
        path: string;
        packageJson: Package.IJson;
        version: string;
        requiredVersion: string;
        resolvedAtParent: { [key: string]: any; };
        resolvedAtGrandparent: { [key: string]: any; };
        children: IPackage[];
        directories: string[];
        availability: Package.Availability;

        scriptFiles: Source.IFile[];
        nativeFiles: { [platform: string]: Source.IFile[] };
    }

    export interface IPackageMap {
        [dependency: string]: IPackage;
    }

    export class Source {

        public app: IPackage;

        /**
         * A flattened view of the project dependencies.
         */
        public dependencies: IPackageMap;

        constructor(private project: Project,
            public platforms: string[],
            private $fs: IFileSystem,
            private $logger: ILogger) {

            this.app = {
                type: Package.Type.App,
                name: ".",
                path: ".",
                packageJson: null,
                requiredVersion: "*",
                version: null,
                resolvedAtParent: {},
                resolvedAtGrandparent: {},
                children: [],
                scriptFiles: [],
                nativeFiles: {},
                directories: [],
                availability: Package.Availability.Available
            };
            this.dependencies = {};

            project.track("read dependencies", () => this.selectDependencyPackages(this.app));
            project.track("read dependencies script files", () => this.listDependencyScriptFiles(this.app));
            project.track("read dependencies native files", () => this.listDependencyNativeFiles());

            project.track("read app script files", () => this.listAppScriptFiles());
            project.track("read app native files", () => this.listAppNativeFiles());

            let level = this.$logger.getLevel();
            if (level === "TRACE" || level === "DEBUG") {
                this.printPackages();
            }

            if (level === "DEBUG") {
                this.printFiles();
            }
        }

        private selectDependencyPackages(pack: IPackage) {

            let packageJsonPath = join(this.project.path, pack.path, "package.json");

            if (!this.$fs.exists(packageJsonPath).wait()) {
                pack.availability = Package.Availability.NotInstalled;
                return;
            }

            if (pack.name in pack.resolvedAtGrandparent) {
                pack.availability = Package.Availability.ShadowedByAncestor;
                return;
            }

            // TODO: mind BOM
            pack.packageJson = JSON.parse(this.$fs.readText(packageJsonPath).wait());
            pack.version = pack.packageJson.version;

            if (pack.type === Package.Type.App) {
                if (pack.packageJson.nativescript && pack.packageJson.nativescript.id) {
                    pack.name = pack.packageJson.nativescript.id;
                }
            } else if (pack.name in this.dependencies) {
                // Resolve conflicts
                let other = this.dependencies[pack.name];
                // Get the one with higher version...
                let packVersion = pack.packageJson.version;
                let otherVersion = other.packageJson.version;
                if (semver.gt(packVersion, otherVersion)) {
                    pack.availability = Package.Availability.Available;
                    other.availability = Package.Availability.ShadowedByDiverged;
                    this.dependencies[pack.name] = pack;
                } else {
                    pack.availability = Package.Availability.ShadowedByDiverged;
                }
            } else {
                pack.availability = Package.Availability.Available;
                this.dependencies[pack.name] = pack;
            }

            let resolved: { [key: string]: any; } = {};
            for (let key in pack.resolvedAtParent) {
                resolved[key] = pack.resolvedAtParent[key];
            }
            for (let dependency in pack.packageJson.dependencies) {
                resolved[dependency] = true;
            }

            for (let dependency in pack.packageJson.dependencies) {
                let requiredVersion = pack.packageJson.dependencies[dependency];
                let dependencyPath = join(pack.path, "node_modules", dependency);
                let child: IPackage = {
                    type: Package.Type.Package,
                    name: dependency,
                    path: dependencyPath,
                    packageJson: null,
                    version: null,
                    requiredVersion,
                    resolvedAtGrandparent: pack.resolvedAtParent,
                    resolvedAtParent: resolved,
                    children: [],
                    scriptFiles: [],
                    nativeFiles: {},
                    directories: [],
                    availability: Package.Availability.NotInstalled
                };
                pack.children.push(child);
                this.selectDependencyPackages(child);
            }
        }

        private listAppScriptFiles() {
            let appPath = "app";
            let ignoreFiles = {
                ["app" + sep + "App_Resources"]: true
            };

            if (this.$fs.exists(join(this.project.path, appPath)).wait()) {
                this.app.directories.push("app/");
                let listAppFiles = (dir: string) => {
                    this.$fs.readDirectory(join(this.project.path, dir)).wait().forEach(name => {
                        let path = dir + sep + name;
                        if (path in ignoreFiles) {
                            return;
                        }
                        let dirPath = path + sep;
                        let absolutePath = join(this.project.path, path);
                        let lstat = this.$fs.getFsStats(absolutePath).wait();
                        if (lstat.isDirectory()) {
                            this.app.directories.push(dirPath);
                            listAppFiles(path);
                        } else if (lstat.isFile()) {
                            let extension = extname(name);
                            let mtime = lstat.mtime.getTime();
                            this.app.scriptFiles.push({ path, extension, mtime, name, absolutePath });
                        }
                    });
                };
                listAppFiles(appPath);
            }
        }

        private listAppNativeFiles() {
            let appResources = join("app", "App_Resources");
            this.platforms.forEach(platform => {
                let platformDir = join(appResources, platform);
                let absolutePath = join(this.project.path, platformDir);
                if (this.$fs.exists(absolutePath).wait()) {
                    this.app.nativeFiles[platform] = [];
                    this.listAppNativeFilesForPlatform(platform, platformDir);
                }
            });
        }

        private listAppNativeFilesForPlatform(platform: string, dir: string) {
            this.$fs.readDirectory(dir).wait().forEach(name => {
                let path = dir + sep + name;
                let absolutePath = this.project.path + sep + path;
                let lstat = this.$fs.getFsStats(absolutePath).wait();
                let mtime = lstat.mtime.getTime();
                let extension = extname(name);
                this.app.nativeFiles[platform].push({ name, path, mtime, absolutePath, extension });
            });
        }

        private listDependencyNativeFiles() {
            for (let key in this.dependencies) {
                this.listNativeFilesInPackage(this.dependencies[key]);
            }
        }

        private listNativeFilesInPackage(pack: IPackage) {
            if (pack.packageJson.nativescript && pack.packageJson.nativescript.platforms) {
                for (let platform in pack.packageJson.nativescript.platforms) {
                    let platformDir = join(this.project.path, pack.path, "platforms", platform);
                    if (this.$fs.exists(platformDir).wait()) {
                        pack.nativeFiles[platform] = [];
                        this.listNativePlatformFilesInPackage(pack, platform, join("platforms", platform));
                    }
                }
            }
        }

        private listNativePlatformFilesInPackage(pack: IPackage, platform: string, dir: string) {
            this.$fs.readDirectory(this.project.path + sep + pack.path + sep + dir).wait().forEach(name => {
                let absolutePath = join(this.project.path, pack.path, dir, name);
                let stats = this.$fs.getFsStats(absolutePath).wait();
                let path = dir + sep + name;
                if (stats.isFile()) {
                    let mtime = stats.mtime.getTime();
                    let extension = extname(name);
                    pack.nativeFiles[platform].push({ absolutePath, name, path, mtime, extension });
                } else if (stats.isDirectory()) {
                    this.listNativePlatformFilesInPackage(pack, platform, path);
                }
            });
        }

        private listDependencyScriptFiles(pack: IPackage) {
            // TODO: Use this.packages instead of recursively walking the app's available dependencies
            if (pack.type === Package.Type.Package && pack.availability === Package.Availability.Available) {
                this.listNestedPackageFiles(pack, pack.path, pack);
            }
            pack.children.forEach(child => this.listDependencyScriptFiles(child));
        }

        private listNestedPackageFiles(pack: IPackage, dir: string, fileScope: IPackage) {
            // TODO: Once per pack:
            let modulePackageJson = pack.path + sep + "package.json";
            let ignorePaths: { [key:string]: boolean } = {
                [pack.path + sep + "node_modules"]: true
            };
            if (pack.packageJson.nativescript) {
                ignorePaths[pack.path + sep + "platforms"] = true;
            }

            // TODO: Separate the listing of nested packages.
            let scopePathLength = fileScope.path.length + sep.length;
            this.$fs.readDirectory(join(this.project.path, dir)).wait().forEach(name => {
                let path = dir + sep + name;
                if (path in ignorePaths) {
                    return;
                }
                let absolutePath = join(this.project.path, path);
                let lstat = this.$fs.getFsStats(absolutePath).wait();
                if (lstat.isDirectory()) {
                    let packageJsonPath = path + sep + "package.json";
                    if (modulePackageJson !== packageJsonPath && this.$fs.exists(join(this.project.path, packageJsonPath)).wait()) {
                        let packageJson = JSON.parse(this.$fs.readText(join(this.project.path, packageJsonPath)).wait());

                        let nestedPackage: IPackage = {
                            type: Package.Type.Nested,
                            name: path.substr(pack.path.length + sep.length),
                            path,
                            packageJson,
                            version: null,
                            requiredVersion: null,
                            resolvedAtParent: null,
                            resolvedAtGrandparent: null,
                            children: [],
                            scriptFiles: [],
                            nativeFiles: {},
                            directories: [],
                            availability: Package.Availability.Available
                        };

                        pack.children.push(nestedPackage);

                        if (nestedPackage.name in this.dependencies) {
                            pack.availability = Package.Availability.ShadowedByDiverged;
                        } else {
                            this.dependencies[nestedPackage.name] = nestedPackage;
                        }
                        this.listNestedPackageFiles(pack, path, nestedPackage);
                    } else {
                        let relativePath = path.substr(scopePathLength);
                        fileScope.directories.push(relativePath);
                        this.listNestedPackageFiles(pack, path, fileScope);
                    }
                } else if (lstat.isFile()) {
                    path = path.substr(scopePathLength);
                    let mtime = lstat.mtime.getTime();
                    let extension = extname(name);
                    fileScope.scriptFiles.push({ path, name, mtime, extension, absolutePath });
                }
            });
        }

        private printPackages() {
            let avLabel: { [key: number]: string } = {
                [Package.Availability.Available]: "",
                [Package.Availability.NotInstalled]: "(not installed)",
                [Package.Availability.ShadowedByAncestor]: "(shadowed by ancestor)",
                [Package.Availability.ShadowedByDiverged]: "(shadowed by diverged)"
            };

            let avSign: { [key: number]: string } = {
                [Package.Availability.Available]: "✔",
                [Package.Availability.NotInstalled]: "✘",
                [Package.Availability.ShadowedByAncestor]: "✘",
                [Package.Availability.ShadowedByDiverged]: "✘"
            };

            let printPackagesRecursive = (pack: IPackage, ident: string, parentIsLast: boolean) => {
                this.$logger.trace(ident + (this.app === pack ? "" : (parentIsLast ? "└── " : "├── ")) + avSign[pack.availability] + " " + pack.name + (pack.version ? "@" + pack.version : "") + " " + avLabel[pack.availability] + (pack.scriptFiles.length > 0 ? "(" + pack.scriptFiles.length + ")" : ""));
                pack.children.forEach((child, index, children) => {
                    let isLast = index === children.length - 1;
                    printPackagesRecursive(child, ident + (this.app === pack ? "" : (parentIsLast ? "    " : "│   ")), isLast);
                });
            };

            printPackagesRecursive(this.app, "", true);
        }

        private printFiles() {
            this.$logger.debug("app: " + this.app.name);
            this.app.scriptFiles.forEach(f => this.$logger.debug("  " + f.path));
            Object.keys(this.dependencies).forEach(dependecy => {
                let pack = this.dependencies[dependecy];
                this.$logger.debug("dependency: " + pack.name + " at " + pack.path);
                this.$logger.debug("script files:")
                pack.scriptFiles.forEach(f => this.$logger.debug("  " + f.path));
                for (let platform in pack.nativeFiles) {
                    this.$logger.debug("native " + platform + " files:");
                    pack.nativeFiles[platform].forEach(f => this.$logger.debug("  " + f.path));
                }
            });
        }
    }

    namespace Source {
        export interface IFile {
            /**
             * Source path relative to the Package.
             */
            path: string;

            /**
             * Absolute path on the local file system.
             */
            absolutePath: string;

            /**
             * File name;
             */
            name: string;

            /**
             * File extension.
             */
            extension: string;

            /**
             * Modified time in milliseconds elapsed after 1 January 1970 00:00:00 UTC.
             */
            mtime: number;
        }
    }

    export class Target {

        public projectBuildResult: IProjectBuildResult = {
            changedNativeProject: false,
            changedScripts: false
        };

        private source: Source;

        constructor(private project: Project,
            private platform: string,
            private output: Target.IOutPaths,
            public $fs: IFileSystem,
            public $logger: ILogger) {

            this.source = project.source;
        }

        public rebuild() {
            this.project.track("rebuild " + this.platform, () => {
                // Expand this into a build system...

                // Handles scripts
                let delta = this.project.track("rebuild delta", () => this.rebuildDelta());

                // Very verbose:
                if (this.$logger.getLevel() === "DEBUG") {
                    this.printDelta(delta);
                }

                this.project.track("apply delta", () => this.applyDelta(delta));

                // TODO: Replace this with the build of all the native resources.
                this.project.track("check native code", () => {
                    let hasNativeChanges = false;
                    let projectAbsolutePath = join(this.project.path, this.output.root, "project");
                    if (this.$fs.exists(projectAbsolutePath).wait()) {
                        let outputProjectMtime = this.$fs.getFsStats(projectAbsolutePath).wait().mtime.getTime();
                        let deps = this.project.source.dependencies;
                        let hasNewerNativeFiles = (pack: IPackage) => {
                            let nativeFiles = pack.nativeFiles[this.platform];
                            return nativeFiles && nativeFiles.some(file => file.mtime > outputProjectMtime);
                        };
                        hasNativeChanges = hasNativeChanges
                            || Object.keys(deps).some(dep => hasNewerNativeFiles(deps[dep]))
                            || hasNewerNativeFiles(this.project.source.app);
                    } else {
                        hasNativeChanges = true;
                    }
                    this.$fs.writeFile(projectAbsolutePath, "Last build: " + new Date().toString()).wait();
                    this.projectBuildResult.changedNativeProject = hasNativeChanges;
                });
            });
        }

        private printDelta(delta: Target.IDelta) {
            this.$logger.debug("mkdir:");
            Object.keys(delta.mkdir).sort().forEach(d => this.$logger.debug("    " + d));

            this.$logger.debug("copy:");
            Object.keys(delta.copy).sort().forEach(f => this.$logger.debug("    " + f + " < " + delta.copy[f].absolutePath));

            this.$logger.debug("rmfile:");
            Object.keys(delta.rmfile).sort().forEach(f => this.$logger.debug("    " + f));

            this.$logger.debug("rmdir:");
            Object.keys(delta.rmdir).sort().reverse().forEach(d => this.$logger.debug("    " + d));
        }

        private buildDelta(): Target.IDelta {
            let platformSuffix = "." + this.platform + ".";
            let platformSuffixFilter = this.source.platforms.filter(p => p !== this.platform).map(p => "." + p + ".");

            let delta: Target.IDelta = {
                mkdir: {},
                copy: {},
                rmfile: {},
                rmdir: {}
            };

            function mkdirRecursive(baseDir: string) {
                utils.path.basedirs(baseDir).forEach(dir => delta.mkdir[dir] = true);
            }

            mkdirRecursive(this.output.app);
            mkdirRecursive(this.output.modules);

            let appPrefixLength = ("app" + sep).length;
            let mapPath = (path: string): string => {
                let relativePath = path.substr(appPrefixLength);
                if (relativePath.length > 0) {
                    return this.output.app + sep + relativePath;
                } else {
                    return null;
                }
            };

            this.source.app.directories.map(mapPath).filter(f => f != null).forEach(file => delta.mkdir[file] = true);
            this.source.app.scriptFiles.forEach(file => delta.copy[mapPath(file.path)] = file);

            let copyAll = (pack: IPackage): void => {
                pack.scriptFiles.forEach(file => {
                    if (platformSuffixFilter.some(f => file.name.indexOf(f) >= 0)) {
                        return;
                    }
                    // TODO: file.path may contain .android. or .ios. in a directory instead of the file name... use file.dir + sep + file.name.replace...
                    let to = this.output.modules + sep + pack.name + sep + file.path.replace(platformSuffix, ".");
                    // TODO: If `to in delta.copy`, log collision.
                    delta.copy[to] = file;
                });
            };

            let mkdirAll = (pack: IPackage): void => {
                if (pack.type === Package.Type.App) {
                    return;
                }

                let path = this.output.modules + sep;
                pack.name.split(sep).forEach(dir => {
                    path = path + dir + sep;
                    delta.mkdir[path] = true;
                });

                pack.directories.forEach(dir => {
                    path = this.output.modules + sep + pack.name + sep + dir + sep;
                    delta.mkdir[path] = true;
                });
            };

            for (let key in this.source.dependencies) {
                let pack = this.source.dependencies[key];
                copyAll(pack);
                mkdirAll(pack);
            }

            return delta;
        }

        private rebuildDelta(): Target.IDelta {
            let buildDelta = this.buildDelta();

            let delta: Target.IDelta = {
                copy: buildDelta.copy,
                mkdir: buildDelta.mkdir,
                rmdir: {},
                rmfile: {}
            };

            let diffed: { [path: string]: boolean } = {};
            let diff = (filePath: string) => {
                if (filePath in diffed) {
                    return;
                }
                diffed[filePath] = true;

                let dirPath = filePath + sep;
                // TODO: Consider making Source.File-s from entries in the platforms/ios and platform/android.
                let targetStat = this.$fs.getFsStats(join(this.project.path, filePath)).wait();
                if (targetStat.isDirectory()) {
                    if (dirPath in delta.mkdir) {
                        delete delta.mkdir[dirPath];
                    } else {
                        delta.rmdir[dirPath] = true;
                    }
                    this.$fs.readDirectory(join(this.project.path, filePath)).wait().forEach(f => diff(dirPath + f));
                } else if (targetStat.isFile()) {
                    if (filePath in delta.copy) {
                        let source = delta.copy[filePath];
                        let newer = targetStat.mtime.getTime() < source.mtime;
                        if (!newer) {
                            delete delta.copy[filePath];
                        }
                    } else {
                        delta.rmfile[filePath] = true;
                    }
                }
            };

            if (this.$fs.exists(join(this.project.path, this.output.app)).wait()) {
                diff(this.output.app);
            }
            utils.path.basedirs(this.output.app).filter(dir => this.$fs.exists(join(this.project.path, dir)).wait() && dir in delta.mkdir).forEach(dir => delete delta.mkdir[dir]);
            if (this.$fs.exists(join(this.project.path, this.output.modules)).wait()) {
                diff(this.output.modules);
            }
            utils.path.basedirs(this.output.modules).filter(dir => this.$fs.exists(join(this.project.path, dir)).wait() && dir in delta.mkdir).forEach(dir => delete delta.mkdir[dir]);

            return delta;
        }

        private applyDelta(delta: Target.IDelta) {
            let mkdir = Object.keys(delta.mkdir).sort();
            let copy = Object.keys(delta.copy);
            let rmfile = Object.keys(delta.rmfile);
            let rmdir = Object.keys(delta.rmdir).sort().reverse();

            mkdir.forEach(dir => this.$fs.createDirectory(join(this.project.path, dir)).wait());
            copy.forEach(to => {
                let from = delta.copy[to];
                this.$fs.copyFile(from.absolutePath, join(this.project.path, to)).wait();
            });
            rmfile.forEach(file => this.$fs.deleteFile(join(this.project.path, file)));
            rmdir.forEach(dir => this.$fs.deleteDirectory(join(this.project.path, dir)));

            this.projectBuildResult.changedScripts = copy.length > 0 || rmfile.length > 0;
        }
    }

    export namespace Target {
        export interface IDelta {
            copy: { [to: string]: Source.IFile };
            mkdir: { [dir: string]: boolean }; /* Set<string> */
            rmfile: { [dir: string]: boolean }; /* Set<string> */
            rmdir: { [dir: string]: boolean }; /* Set<string> */
        }

        export interface IOutPaths {
            /**
             * The location where app resources should be deployed, relative to the project root.
             */
            app: string;

            /**
             * The location where flattened modules should be deployed, relative to the project root.
             */
            modules: string;

            /**
             * The root directory holding all the output for this target, ex: "platforms/android", "platforms/ios", etc, relative to the project root.
             */
            root: string;
        }

        export class IOS extends Target {
            constructor(project: Project,
                $fs: IFileSystem,
                $logger: ILogger) {

                super(project, "ios", {
                    root: join("platforms", "ios"),
                    // TODO: This basename tries to figure out the xcode project name... inject from outside.
                    app: join("platforms", "ios", basename(project.path), "app"),
                    modules: join("platforms", "ios", basename(project.path), "app", "tns_modules")
                }, $fs, $logger);
            }
        }

        export class Android extends Target {
            constructor(project: Project,
                $fs: IFileSystem,
                $logger: ILogger) {

                super(project, "android", {
                    root: join("platforms", "android"),
                    app: join("platforms", "android", "src", "main", "assets", "app"),
                    modules: join("platforms", "android", "src", "main", "assets", "app", "tns_modules"),
                }, $fs, $logger);
            }
        }
    }
}

namespace utils {
    export namespace path {
        /**
         * Return all base directories in ascending order.
         * For example basedirs("platforms/ios/test/") will yield ["platforms/", "platforms/ios/", "platforms/ios/tests/"]. 
         */
        export function basedirs(dir: string): string[] {
            let result: string[] = [];
            let path: string = "";
            dir.split(sep).forEach(f => result.push(path += f + sep));
            return result;
        }
    }
}
