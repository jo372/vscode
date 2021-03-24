/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as platform from 'vs/base/common/platform';
import { normalize, basename } from 'vs/base/common/path';
import { enumeratePowerShellInstallations } from 'vs/base/node/powershell';
import { getWindowsBuildNumber } from 'vs/platform/terminal/node/terminalEnvironment';
import { ITerminalConfiguration, ITerminalProfile, ITerminalProfileObject, ProfileSource } from 'vs/workbench/contrib/terminal/common/terminal';
import * as cp from 'child_process';
import { ExtHostVariableResolverService } from 'vs/workbench/api/common/extHostDebugService';
import { IWorkspaceFolder } from 'vs/platform/workspace/common/workspace';
import { ILogService } from 'vs/platform/log/common/log';

let profileSources: Map<string, IPotentialTerminalProfile> | undefined;

export function detectAvailableProfiles(quickLaunchOnly: boolean, logService?: ILogService, config?: ITerminalConfiguration, variableResolver?: ExtHostVariableResolverService, workspaceFolder?: IWorkspaceFolder, statProvider?: IStatProvider, testPaths?: string[]): Promise<ITerminalProfile[]> {
	const provider = statProvider ? statProvider : fs.promises;
	return platform.isWindows ? detectAvailableWindowsProfiles(quickLaunchOnly, provider, logService, config?.showQuickLaunchWslProfiles, config?.profiles.windows, variableResolver, workspaceFolder) : detectAvailableUnixProfiles(provider, logService, quickLaunchOnly, platform.isMacintosh ? config?.profiles.osx : config?.profiles.linux, testPaths, variableResolver, workspaceFolder);
}

async function detectAvailableWindowsProfiles(quickLaunchOnly: boolean, statProvider: IStatProvider, logService?: ILogService, showQuickLaunchWslProfiles?: boolean, configProfiles?: { [key: string]: ITerminalProfileObject }, variableResolver?: ExtHostVariableResolverService, workspaceFolder?: IWorkspaceFolder): Promise<ITerminalProfile[]> {
	// Determine the correct System32 path. We want to point to Sysnative
	// when the 32-bit version of VS Code is running on a 64-bit machine.
	// The reason for this is because PowerShell's important PSReadline
	// module doesn't work if this is not the case. See #27915.
	const is32ProcessOn64Windows = process.env.hasOwnProperty('PROCESSOR_ARCHITEW6432');
	const system32Path = `${process.env['windir']}\\${is32ProcessOn64Windows ? 'Sysnative' : 'System32'}`;

	let useWSLexe = false;

	if (getWindowsBuildNumber() >= 16299) {
		useWSLexe = true;
	}

	await initializeWindowsProfiles();

	const detectedProfiles: Map<string, ITerminalProfileObject> = new Map();

	// Add non-quick launch profiles
	if (!quickLaunchOnly) {
		detectedProfiles.set('PowerShell', { source: ProfileSource.Pwsh });
		detectedProfiles.set('Git Bash', { source: ProfileSource.GitBash });
		detectedProfiles.set('Cygwin', {
			path: [
				`${process.env['HOMEDRIVE']}\\cygwin64\\bin\\bash.exe`,
				`${process.env['HOMEDRIVE']}\\cygwin\\bin\\bash.exe`
			],
			args: ['--login']
		});
		detectedProfiles.set('Command Prompt',
			{
				path: [`${system32Path}\\cmd.exe`]
			},
		);
	}

	for (const [profileName, value] of Object.entries(configProfiles || {})) {
		if (value === null) { detectedProfiles.delete(profileName); }
		detectedProfiles.set(profileName, value);
	}

	const resultProfiles: ITerminalProfile[] = await transformToTerminalProfiles(detectedProfiles.entries(), statProvider, logService, variableResolver, workspaceFolder);

	if (!quickLaunchOnly || (quickLaunchOnly && showQuickLaunchWslProfiles)) {
		resultProfiles.push(... await getWslProfiles(`${system32Path}\\${useWSLexe ? 'wsl.exe' : 'bash.exe'}`, showQuickLaunchWslProfiles));
	}

	return resultProfiles;
}

async function transformToTerminalProfiles(entries: IterableIterator<[string, ITerminalProfileObject]>, statProvider: IStatProvider, logService?: ILogService, variableResolver?: ExtHostVariableResolverService, workspaceFolder?: IWorkspaceFolder): Promise<ITerminalProfile[]> {
	const resultProfiles: ITerminalProfile[] = [];
	for (const [profileName, profile] of entries) {
		if (profile === null) { continue; }
		let paths: string[];
		let args: string[] | string | undefined;
		if ('source' in profile) {
			const source = profileSources?.get(profile.source);
			if (!source) {
				continue;
			}
			paths = source.paths.slice();
			args = source.args;
		} else {
			paths = Array.isArray(profile.path) ? profile.path : [profile.path];
			args = profile.args;
		}
		for (let i = 0; i < paths.length; i++) {
			paths[i] = variableResolver?.resolve(workspaceFolder, paths[i]) || paths[i];
		}
		const validatedProfile = await validateProfilePaths(profileName, paths, statProvider, args, logService);
		if (validatedProfile) {
			resultProfiles.push(validatedProfile);
		} else {
			logService?.trace('profile not validated', profileName, paths);
		}
	}
	return resultProfiles;
}

async function initializeWindowsProfiles(): Promise<void> {
	if (profileSources) {
		return;
	}

	profileSources = new Map();
	profileSources.set(
		'Git Bash', {
		profileName: 'Git Bash',
		paths: [
			`${process.env['ProgramW6432']}\\Git\\bin\\bash.exe`,
			`${process.env['ProgramW6432']}\\Git\\usr\\bin\\bash.exe`,
			`${process.env['ProgramFiles']}\\Git\\bin\\bash.exe`,
			`${process.env['ProgramFiles']}\\Git\\usr\\bin\\bash.exe`,
			`${process.env['LocalAppData']}\\Programs\\Git\\bin\\bash.exe`
		],
		args: ['--login']
	}
	);
	profileSources.set('Cygwin', {
		profileName: 'Cygwin',
		paths: [
			`${process.env['HOMEDRIVE']}\\cygwin64\\bin\\bash.exe`,
			`${process.env['HOMEDRIVE']}\\cygwin\\bin\\bash.exe`
		],
		args: ['--login']
	});
	for (const profile of await getPowershellProfiles()) {
		profileSources.set(profile.profileName, { profileName: profile.profileName, paths: profile.paths, args: profile.args });
	}
}

async function getPowershellProfiles(): Promise<IPotentialTerminalProfile[]> {
	const profiles: IPotentialTerminalProfile[] = [];
	// Add all of the different kinds of PowerShells
	for await (const pwshExe of enumeratePowerShellInstallations()) {
		profiles.push({ profileName: pwshExe.displayName, paths: [pwshExe.exePath] });
	}
	return profiles;
}

async function getWslProfiles(wslPath: string, showQuickLaunchWslProfiles?: boolean): Promise<ITerminalProfile[]> {
	const profiles: ITerminalProfile[] = [];
	if (showQuickLaunchWslProfiles) {
		const distroOutput = await new Promise<string>((resolve, reject) => {
			// wsl.exe output is encoded in utf16le (ie. A -> 0x4100)
			cp.exec('wsl.exe -l', { encoding: 'utf16le' }, (err, stdout) => {
				if (err) {
					return reject('Problem occurred when getting wsl distros');
				}
				resolve(stdout);
			});
		});
		if (distroOutput) {
			const regex = new RegExp(/[\r?\n]/);
			const distroNames = distroOutput.split(regex).filter(t => t.trim().length > 0 && t !== '');
			// don't need the Windows Subsystem for Linux Distributions header
			distroNames.shift();
			for (let distroName of distroNames) {
				// Remove default from distro name
				distroName = distroName.replace(/ \(Default\)$/, '');

				// Skip empty lines
				if (distroName === '') {
					continue;
				}

				// docker-desktop and docker-desktop-data are treated as implementation details of
				// Docker Desktop for Windows and therefore not exposed
				if (distroName.startsWith('docker-desktop')) {
					continue;
				}

				// Add the profile
				profiles.push({
					profileName: `${distroName} (WSL)`,
					path: wslPath,
					args: [`-d`, `${distroName}`]
				});
			}
			return profiles;
		}
	}
	return [];
}

async function detectAvailableUnixProfiles(statProvider: IStatProvider, logService?: ILogService, quickLaunchOnly?: boolean, configProfiles?: { [key: string]: ITerminalProfileObject }, testPaths?: string[], variableResolver?: ExtHostVariableResolverService, workspaceFolder?: IWorkspaceFolder): Promise<ITerminalProfile[]> {
	const detectedProfiles: Map<string, ITerminalProfileObject> = new Map();

	// Add non-quick launch profiles
	if (!quickLaunchOnly) {
		const contents = await fs.promises.readFile('/etc/shells', 'utf8');
		const profiles = testPaths || contents.split('\n').filter(e => e.trim().indexOf('#') !== 0 && e.trim().length > 0);
		for (const profile of profiles) {
			const profileName = basename(profile);
			detectedProfiles.set(profileName, { path: profile });
		}
	}

	for (const [profileName, value] of Object.entries(configProfiles || {})) {
		if (value === null) {
			detectedProfiles.delete(profileName);
		} else {
			detectedProfiles.set(profileName, value);
		}
	}

	return await transformToTerminalProfiles(detectedProfiles.entries(), statProvider, logService, variableResolver, workspaceFolder);
}

async function validateProfilePaths(label: string, potentialPaths: string[], statProvider: IStatProvider, args?: string[] | string, logService?: ILogService): Promise<ITerminalProfile | undefined> {
	if (potentialPaths.length === 0) {
		return Promise.resolve(undefined);
	}
	const current = potentialPaths.shift()!;
	if (current === '') {
		return validateProfilePaths(label, potentialPaths, statProvider, args);
	}

	if (basename(current) === current) {
		return {
			profileName: label,
			path: current,
			args
		};
	}

	try {
		const result = await fs.promises.stat(normalize(current));
		if (result.isFile() || result.isSymbolicLink()) {
			if (args) {
				return {
					profileName: label,
					path: current,
					args
				};
			} else {
				return {
					profileName: label,
					path: current
				};
			}
		}
	} catch (e) {
		logService?.info('error', e);
		// Also try using lstat as some symbolic links on Windows
		// throw 'permission denied' using 'stat' but don't throw
		// using 'lstat'
		try {
			const result = await fs.promises.lstat(normalize(current));
			if (result.isFile() || result.isSymbolicLink()) {
				if (args) {
					return {
						profileName: label,
						path: current,
						args
					};
				} else {
					return {
						profileName: label,
						path: current
					};
				}
			}
		}
		catch (e) {
			// noop
		}
	}
	return validateProfilePaths(label, potentialPaths, statProvider, args);
}

export interface IStatProvider {
	stat(path: string): Promise<{
		isFile(): boolean;
		isSymbolicLink(): boolean;
	}>,
	lstat(path: string): Promise<{
		isFile(): boolean;
		isSymbolicLink(): boolean;
	}>
}

interface IPotentialTerminalProfile {
	profileName: string,
	paths: string[],
	args?: string[]
}
