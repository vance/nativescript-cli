///<reference path="../.d.ts"/>

export class BuildCommand implements ICommand {
	constructor(private $platformService: IPlatformService) { }

	execute(args: string[]): IFuture<void> {
		return (() => {
			this.$platformService.buildPlatform(args[0]).wait();
		}).future<void>()();
	}
}
$injector.registerCommand("build", BuildCommand);