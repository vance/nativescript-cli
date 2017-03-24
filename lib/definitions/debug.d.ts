interface IDebugOptions {
	chrome?: boolean;
	start?: boolean;
	stop?: boolean;
	emulator?: boolean;
	device?: string;
	debugBrk?: boolean;
	forDevice?: boolean;
	client?: boolean;
	justlaunch?: boolean;
}

interface IDebugService {
	debug(projectData: IProjectData, debugOptions: IDebugOptions): Promise<string>;
	debugStart(projectData: IProjectData, debugOptions: IDebugOptions): Promise<void>;
	debugStop(): Promise<void>
	platform: string;
}
