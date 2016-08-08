var Future = require("fibers/future");

// TODO: Use the injector for this
import { Project } from "../build/project";

export class RebuildCommand implements ICommand {
	constructor(
		private $projectData: IProjectData,
		private $hooksService: IHooksService,
		private $platformService: IPlatformService)
	{
	}

	public allowedParameters: ICommandParameter[] = [];

	public execute(args: string[]): IFuture<void> {
		return (() => {
			// console.log("prepare");
			// console.time("prepare");
			// this.$platformService.preparePlatform("ios").wait();
			// console.timeEnd("prepare");

			console.log("Uptime at the start of RebuildCommand.execute: " + process.uptime());

			let project = new Project(this.$projectData.projectDir);

			// this.$hooksService.executeBeforeHooks("prepare").wait();
			project.rebuild();
			// this.$hooksService.executeAfterHooks("prepare").wait();

		}).future<void>()();
	}

	public canExecute(args: string[]): IFuture<boolean> {
		return Future.fromResult(true);
	}
}
$injector.registerCommand("rebuild", RebuildCommand);