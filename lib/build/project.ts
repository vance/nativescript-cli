import { join, sep, dirname, basename } from "path";
import * as semver from "semver";

export class Project implements IProject {

    public source: Project.Source;

    constructor(public path: string,
        public $fs: IFileSystem,
        public $logger: ILogger) {

        this.$logger.trace("New project to prepare at: " + this.path);
    }

    public rebuild(platform: string): IFuture<IProjectBuildResult> {
        return (() =>  {
            this.$logger.info("Project rebuild " + platform + " ...");
            let projectBuildResult: IProjectBuildResult;

            this.track("rebuild", () => {

                this.source = new Project.Source(this, ["ios", "android"], this.$fs, this.$logger);

                let platforms = {
                    ios: new Project.Target.iOS(this, this.$fs, this.$logger),
                    android: new Project.Target.Android(this, this.$fs, this.$logger)
                }

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
            this.$logger.trace(label + " ✔")
        }
        return result;
    }
}
$injector.register("project", Project);

export namespace Project {
    export namespace Package {
        export interface Json {
            name?: string;
            version?: string;
            dependencies?: { [key: string]: string };
            devDependencies?: { [key: string]: string };
            nativescript: {
                id: string;
            }
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

    export interface Package {
        type: Package.Type;
        name: string;
        path: string;
        packageJson: Package.Json;
        version: string;
        requiredVersion: string;
        resolvedAtParent: { [key: string]: any; };
        resolvedAtGrandparent: { [key: string]: any; };
        children: Package[];
        scriptFiles: string[];
        directories: string[];
        availability: Package.Availability;
    }

    export interface PackageMap {
        [dependency: string]: Package;
    }

    export class Source {

        public app: Package;
        public packages: PackageMap;

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
                directories: [],
                availability: Package.Availability.Available
            }
            this.packages = {};

            project.track("read dependencies", () => this.selectDependencyPackages(this.app));
            project.track("read dependency files", () => this.listPackageFiles(this.app));
            project.track("read app files", () => this.listAppFiles());

            let level = this.$logger.getLevel();
            if (level === "TRACE" || level == "DEBUG") {
                this.printPackages();
            }

            if (level === "DEBUG") {
                this.printFiles();
            }
        }

        private selectDependencyPackages(pack: Package) {

            let packageJsonPath = join(pack.path, "package.json");

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
            } else if (pack.name in this.packages) {
                // Resolve conflicts
                let other = this.packages[pack.name];
                // Get the one with higher version...
                let packVersion = pack.packageJson.version;
                let otherVersion = other.packageJson.version;
                if (semver.gt(packVersion, otherVersion)) {
                    pack.availability = Package.Availability.Available;
                    other.availability = Package.Availability.ShadowedByDiverged;
                    this.packages[pack.name] = pack;
                } else {
                    pack.availability = Package.Availability.ShadowedByDiverged;
                }
            } else {
                pack.availability = Package.Availability.Available;
                this.packages[pack.name] = pack;
            }

            let resolved: { [key: string]: any; } = {};
            for (let key in pack.resolvedAtParent) {
                resolved[key] = pack.resolvedAtParent[key];
            }
            for (var dependency in pack.packageJson.dependencies) {
                resolved[dependency] = true;
            }

            for (var dependency in pack.packageJson.dependencies) {
                let requiredVersion = pack.packageJson.dependencies[dependency];
                let dependencyPath = join(pack.path, "node_modules", dependency);
                let child: Package = {
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
                    directories: [],
                    availability: Package.Availability.NotInstalled
                }
                pack.children.push(child);
                this.selectDependencyPackages(child);
            }
        }

        private listAppFiles() {
            let appPath = "app";
            let ignoreFiles = {
                ["app" + sep + "App_Resources"]: true
            };

            if (this.$fs.exists(appPath).wait()) {
                this.app.directories.push("app/");
                let listAppFiles = (path: string) => {
                    this.$fs.readDirectory(path).wait().forEach(f => {
                        let filePath = path + sep + f;
                        if (filePath in ignoreFiles) {
                            return;
                        }
                        let dirPath = filePath + sep;
                        let lstat = this.$fs.getFsStats(filePath).wait();
                        if (lstat.isDirectory()) {
                            this.app.directories.push(dirPath);
                            listAppFiles(filePath);
                        } else if (lstat.isFile()) {
                            this.app.scriptFiles.push(filePath);
                        }
                    });
                }
                listAppFiles(appPath);
            }
        }

        private listPackageFiles(pack: Package) {
            if (pack.type === Package.Type.Package && pack.availability === Package.Availability.Available) {
                this.listNestedPackageFiles(pack, pack.path, pack);
            }
            pack.children.forEach(child => this.listPackageFiles(child));
        }

        private listNestedPackageFiles(pack: Package, dirPath: string, fileScope: Package) {
            // TODO: Once per pack:
            let modulePackageJson = pack.path + sep + "package.json";
            let ignorePaths: { [key:string]: boolean } = {
                [pack.path + sep + "node_modules"]: true,
                [pack.path + sep + "platforms"]: true
            };
            let scopePathLength = fileScope.path.length + sep.length;
            this.$fs.readDirectory(dirPath).wait().forEach(childPath => {
                let path = dirPath + sep + childPath;
                if (path in ignorePaths) {
                    return;
                }
                let stat = this.$fs.getFsStats(path).wait();
                if (stat.isDirectory()) {
                    let packageJsonPath = path + sep + "package.json";
                    if (modulePackageJson != packageJsonPath && this.$fs.exists(packageJsonPath).wait()) {
                        let packageJson = JSON.parse(this.$fs.readText(packageJsonPath).wait());

                        let nestedPackage: Package = {
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
                            directories: [],
                            availability: Package.Availability.Available
                        };

                        pack.children.push(nestedPackage);

                        if (nestedPackage.name in this.packages) {
                            let other = this.packages[pack.name];
                            pack.availability = Package.Availability.ShadowedByDiverged;
                        } else {
                            this.packages[nestedPackage.name] = nestedPackage;
                        }
                        this.listNestedPackageFiles(pack, path, nestedPackage);
                    } else {
                        let relativePath = path.substr(scopePathLength);
                        fileScope.directories.push(relativePath);
                        this.listNestedPackageFiles(pack, path, fileScope);
                    }
                } else if (stat.isFile()) {
                    let relativePath = path.substr(scopePathLength);
                    fileScope.scriptFiles.push(relativePath);
                }
            });
        }

        private printPackages() {
            let avLabel: { [key: number]: string } = {
                [Package.Availability.Available]: "",
                [Package.Availability.NotInstalled]: "(not installed)",
                [Package.Availability.ShadowedByAncestor]: "(shadowed by ancestor)",
                [Package.Availability.ShadowedByDiverged]: "(shadowed by diverged)"
            }

            let avSign: { [key: number]: string } = {
                [Package.Availability.Available]: "✔",
                [Package.Availability.NotInstalled]: "✘",
                [Package.Availability.ShadowedByAncestor]: "✘",
                [Package.Availability.ShadowedByDiverged]: "✘"
            }

            let printPackagesRecursive = (pack: Package, ident: string, parentIsLast: boolean) => {
                this.$logger.trace(ident + (this.app === pack ? "" : (parentIsLast ? "└── " : "├── ")) + avSign[pack.availability] + " " + pack.name + (pack.version ? "@" + pack.version : "") + " " + avLabel[pack.availability] + (pack.scriptFiles.length > 0 ? "(" + pack.scriptFiles.length + ")" : ""));
                pack.children.forEach((child, index, children) => {
                    let isLast = index === children.length - 1;
                    printPackagesRecursive(child, ident + (this.app === pack ? "" : (parentIsLast ? "    " : "│   ")), isLast);
                });
            }

            printPackagesRecursive(this.app, "", true);
        }

        private printFiles() {
            this.$logger.debug("app: " + this.app.name);
            this.app.scriptFiles.forEach(f => this.$logger.debug("  " + f));
            Object.keys(this.packages).forEach(dependecy => {
                let pack = this.packages[dependecy];
                this.$logger.debug("dependency: " + pack.name + " at " + pack.path);
                pack.scriptFiles.forEach(f => this.$logger.debug("  " + f));
            })
        }
    }

    export class Target {

        public projectBuildResult: IProjectBuildResult = {
            changedNativeProject: false,
            changedScripts: false
        }

        private source: Source;

        constructor(private project: Project,
            private platform: string,
            private output: Target.OutPaths,
            public $fs: IFileSystem,
            public $logger: ILogger) {

            this.source = project.source;
        }

        public rebuild() {
            this.project.track("rebuild " + this.platform, () => {
                let delta = this.project.track("rebuild delta", () => this.rebuildDelta());

                // Very verbose:
                if (this.$logger.getLevel() === "DEBUG") {
                    this.printDelta(delta);
                }

                this.project.track("apply delta", () => this.applyDelta(delta));
            });
        }

        private printDelta(delta: Target.Delta) {
            this.$logger.debug("mkdir:");
            Object.keys(delta.mkdir).sort().forEach(d => this.$logger.debug("    " + d));

            this.$logger.debug("copy:");
            Object.keys(delta.copy).sort().forEach(f => this.$logger.debug("    " + f + " < " + delta.copy[f]));

            this.$logger.debug("rmfile:");
            Object.keys(delta.rmfile).sort().forEach(f => this.$logger.debug("    " + f));

            this.$logger.debug("rmdir:");
            Object.keys(delta.rmdir).sort().reverse().forEach(d => this.$logger.debug("    " + d));
        }

        private buildDelta(): Target.Delta {
            let platformSuffix = "." + this.platform + ".";
            let platformSuffixFilter = this.source.platforms.filter(p => p != this.platform).map(p => "." + p + ".");

            let delta: Target.Delta = {
                mkdir: {},
                copy: {},
                rmfile: {},
                rmdir: {}
            }

            function mkdirRecursive(dir: string) {
                utils.path.basedirs(dir).forEach(dir => delta.mkdir[dir] = true);
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
            }

            this.source.app.directories.map(mapPath).filter(f => f != null).forEach(file => delta.mkdir[file] = true);
            this.source.app.scriptFiles.forEach(file => delta.copy[mapPath(file)] = file);

            let copyAll = (pack: Package): void => {
                pack.scriptFiles.forEach(file => {
                    if (platformSuffixFilter.some(f => file.indexOf(f) >= 0)) {
                        return;
                    }
                    let from = pack.path + sep + file;
                    let to = this.output.modules + sep + pack.name + sep + file.replace(platformSuffix, ".");
                    // TODO: If `to in delta.copy`, log collision.
                    delta.copy[to] = from;
                });
            }

            let mkdirAll = (pack: Package): void => {
                if (pack.type === Package.Type.App) {
                    return;
                }

                let path = this.output.modules + sep;
                pack.name.split(sep).forEach(dir => {
                    path = path + dir + sep;
                    delta.mkdir[path] = true;
                });

                pack.directories.forEach(dir => {
                    let path = this.output.modules + sep + pack.name + sep + dir + sep;
                    delta.mkdir[path] = true;
                });
            }

            for (let key in this.source.packages) {
                let pack = this.source.packages[key];
                copyAll(pack);
                mkdirAll(pack);
            }

            return delta;
        }

        private rebuildDelta(): Target.Delta {
            let buildDelta = this.buildDelta();

            let delta: Target.Delta = {
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
                let targetStat = this.$fs.getFsStats(filePath).wait();
                if (targetStat.isDirectory()) {
                    if (dirPath in delta.mkdir) {
                        delete delta.mkdir[dirPath];
                    } else {
                        delta.rmdir[dirPath] = true;
                    }
                    this.$fs.readDirectory(filePath).wait().forEach(f => diff(dirPath + f));
                } else if (targetStat.isFile()) {
                    if (filePath in delta.copy) {
                        let source = delta.copy[filePath];
                        let srcStat = this.$fs.getFsStats(source).wait();
                        let newer = targetStat.mtime.getTime() < srcStat.mtime.getTime();
                        if (!newer) {
                            delete delta.copy[filePath];
                        }
                    } else {
                        delta.rmfile[filePath] = true;
                    }
                }
            };

            if (this.$fs.exists(this.output.app).wait()) {
                diff(this.output.app);
            }
            utils.path.basedirs(this.output.app).filter(dir => this.$fs.exists(dir).wait() && dir in delta.mkdir).forEach(dir => delete delta.mkdir[dir]);
            if (this.$fs.exists(this.output.modules).wait()) {
                diff(this.output.modules);
            }
            utils.path.basedirs(this.output.modules).filter(dir => this.$fs.exists(dir).wait() && dir in delta.mkdir).forEach(dir => delete delta.mkdir[dir]);

            return delta;
        }

        private applyDelta(delta: Target.Delta) {
            let mkdir = Object.keys(delta.mkdir).sort();
            let copy = Object.keys(delta.copy);
            let rmfile = Object.keys(delta.rmfile);
            let rmdir = Object.keys(delta.rmdir).sort().reverse();

            mkdir.forEach(dir => this.$fs.createDirectory(dir).wait());
            copy.forEach(to => {
                let from = delta.copy[to];
                this.$fs.copyFile(from, to).wait();
                // TODO: Sync is fast on my mac, profile the async version... 
                // writeFileSync(to, readFileSync(from));
            });
            rmfile.forEach(file => this.$fs.deleteFile(file));
            rmdir.forEach(dir => this.$fs.deleteDirectory(dir));

            this.projectBuildResult.changedScripts = copy.length > 0 || rmfile.length > 0;
        }
    }

    export namespace Target {
        export interface Delta {
            copy: { [to: string]: /* from: */ string },
            mkdir: { [dir: string]: boolean } /* Set<string> */
            rmfile: { [dir: string]: boolean } /* Set<string> */,
            rmdir: { [dir: string]: boolean } /* Set<string> */,
        }

        export interface OutPaths {
            app: string;
            modules: string;
        }

        export class iOS extends Target {
            constructor(project: Project,
                $fs: IFileSystem,
                $logger: ILogger) {

                super(project, "ios", {
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
                    app: join("platforms", "android", "src", "main", "assets", "app"),
                    modules: join("platforms", "android", "src", "main", "assets", "app", "tns_modules")
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
