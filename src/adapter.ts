import { Mutex } from 'async-mutex';
import * as vscode from "vscode";
import * as logger from './logger';
import { TestExecutable } from './test-executable';
import * as config from './config';
import * as testidutil from './testidutil';
import * as util from './util';
import * as model from './model';

import fs = require('fs');

export class BoostTestAdapter {
    private readonly mutex: Mutex = new Mutex();
    private readonly disposables: { dispose(): void }[] = [];
    private testExecutables: Map<string, TestExecutable> = new Map();
    private watchers: Map<string, vscode.FileSystemWatcher> = new Map();
    private testItem: vscode.TestItem;
    private isRunCancelled = false;
	private globWatchers : vscode.FileSystemWatcher[] = [];

    constructor(
        readonly adapterId: string,
        private readonly ctrl: vscode.TestController,
        readonly workspaceFolder: vscode.WorkspaceFolder,
        private readonly log: logger.MyLogger) {

        log.info("Initializing adapter.");

        this.testItem = this.ctrl.createTestItem(
            this.adapterId,
            this.workspaceFolder.name,
            this.workspaceFolder.uri);

        vscode.workspace.onDidChangeConfiguration(async event => {
            if (event.affectsConfiguration(config.BoosTestAdapterConfig)) {
                try {
                    this.log.info("Configuration changed. Reloading tests.")
                    await this.reload();
                } catch (err) {
                    console.warn(err)
                }
            }
        });

    }

    async reload(): Promise<void> {
        await this.updateSettings();
        await this.load();
    }

    private async updateSettings(): Promise<void> {
        const release = await this.mutex.acquire();
        try {
            await this.updateSettingsUnlocked();
        } finally {
            release();
        }
    }

    private async updateSettingsUnlocked(): Promise<void> {
        this.clearTestExeWatchers();
        this.testExecutables.clear();

		for(const w of this.globWatchers) {
			w.dispose();
		}
		this.globWatchers = [];

        var cfg = await config.getConfig(this.workspaceFolder, this.log);
		if(cfg.testExes.length==0) {
			config.createDefaultConfig(this.workspaceFolder,this.log);
			cfg = await config.getConfig(this.workspaceFolder, this.log);
		}

        for (const cfgTestExe of cfg.testExes) {
			if(cfgTestExe.glob) {
				const binaries = await vscode.workspace.findFiles(cfgTestExe.glob)

				const watcher = vscode.workspace.createFileSystemWatcher(cfgTestExe.glob,false,true,false);
				watcher.onDidCreate(() => { this.reload()});
				watcher.onDidDelete(() => { this.reload()});

				this.globWatchers.push(watcher);
	
				for(const binary of binaries) {
					try {
						const newExe : config.TestExe = { ...cfgTestExe, path: binary.fsPath }
						fs.accessSync(binary.fsPath,fs.constants.X_OK);

						const testExeTestItemId = this.createTestExeId(binary.fsPath);
						this.testExecutables.set(testExeTestItemId, new TestExecutable(
							testExeTestItemId,
							this.ctrl,
							this.workspaceFolder,
							newExe,
							this.log));
						} catch(ex) {}
				}

			} else {
				const testExeTestItemId = this.createTestExeId(cfgTestExe.path);
				this.testExecutables.set(testExeTestItemId, new TestExecutable(
					testExeTestItemId,
					this.ctrl,
					this.workspaceFolder,
					cfgTestExe,
					this.log));
			}
        }
    }

    getTestItem(): vscode.TestItem {
        return this.testItem;
    }

    dispose() {
        this.cancel();
        this.clearTestExeWatchers();
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables.length = 0;
    }

    private async load(): Promise<void> {
        const release = await this.mutex.acquire();
        try {
            await this.loadUnlocked();
        } finally {
            release();
        }
    }

    async run(testRun: vscode.TestRun, testItems: model.TestItem[]): Promise<void> {
        const release = await this.mutex.acquire();
        this.isRunCancelled = false;
        try {
            await this.runUnlocked(testRun, testItems);
        } finally {
            release();
        }
    }

    async debug(testItems: model.TestItem[]): Promise<void> {
        const release = await this.mutex.acquire();
        try {
            await this.debugUnlocked(testItems);
        } finally {
            release();
        }
    }

    cancel() {
        this.isRunCancelled = true;
        for (const [_, testExecutable] of this.testExecutables) {
            testExecutable.cancelTests(this.log);
        }
    }

    private async loadUnlocked(): Promise<void> {
        this.testItem.children.replace([]);

        if (this.testExecutables.size === 0) {
            this.log.info('No valid test executables found. Cannot load tests.');
            return;
        }

        for (const [_, testExecutable] of this.testExecutables) {
            await this.loadTestExeUnlocked(testExecutable);
        }
    }

    private async runUnlocked(
        testRun: vscode.TestRun,
        testItems: model.TestItem[]): Promise<void> {
        const resolvedItems = this.resolveAdapterItemsToTestExeItems(testItems);
        const m = this.groupTestItemsByTestExeId(resolvedItems);
        for (const [testExeId, testExeTestItems] of m) {
            if (this.isRunCancelled) {
                return;
            }
            const testExe = this.testExecutables.get(testExeId);
            if (!testExe) {
                this.log.bug(`Cannot find TestExecutable with ID '${testExeId}'.`);
                this.log.error("Could not run some of the tests!", true);
                continue;
            }
            try {
                await testExe.runTests(testRun, testExeTestItems);
            } catch (e) {
                this.log.exception(e, true);
            }
        }
    }

    private async debugUnlocked(testItems: model.TestItem[]): Promise<void> {
        const resolvedItems = this.resolveAdapterItemsToTestExeItems(testItems);
        const m = this.groupTestItemsByTestExeId(resolvedItems);
        if (m.size > 1) {
            this.log.error("Cannot debug multiple test executables at once", true);
            return;
        }

        const testExeId = testidutil.getTestExeId(resolvedItems[0].id());
        const testExecutable = this.testExecutables.get(testExeId)!;
        await testExecutable.debugTests(resolvedItems, this.log);
    }

    async resolveTestExeTests(testItem: vscode.TestItem): Promise<void> {
        const release = await this.mutex.acquire();
        try {
            await this.resolveTestExeTestsUnlocked(testItem);
        } finally {
            release();
        }
    }

    private async resolveTestExeTestsUnlocked(testItem: vscode.TestItem): Promise<void> {
        const testExe = this.getTestExeOf(testItem);
        if (testExe === undefined) {
            this.log.bug(`Cannot find TestExecutable for TestItem '${testItem.id}'`);
            return;
        }
        this.addTestExeWatcher(testExe);
        await testExe.loadTests();
    }

    private async loadTestExeUnlocked(testExecutable: TestExecutable): Promise<void> {
        try {
            this.testItem.children.add(testExecutable.getTestItem());
        } catch (e) {
            this.log.exception(e);
        }
    }

    private addTestExeWatcher(testExecutable: TestExecutable) {
        const key = testExecutable.testExeTestItemId;
        // start watching test binary
        if (this.watchers.has(key)) {
            return;
        }
        this.log.info(`Watching test executable: ${testExecutable.cfg.path}`);
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(this.workspaceFolder, testExecutable.cfg.path));

        try {
            const load = async (e: vscode.Uri) => {
                this.log.info(`Test executable changed: ${testExecutable.cfg.path}`);
                if (e.fsPath !== testExecutable.absPath) {
                    this.log.warn(`Paths don't match: ${e.fsPath} should be ${testExecutable.absPath}`);
                    return;
                }
                try {
                    await this.resolveTestExeTests(testExecutable.getTestItem());
                } catch (e) {
                    this.log.exception(e);
                }
            };

            watcher.onDidChange(load);
            watcher.onDidCreate(load);
            watcher.onDidDelete(load);
            this.watchers.set(key, watcher);
        } catch (e) {
            this.log.exception(e);
            watcher.dispose();
        }
    }

    private clearTestExeWatchers() {
        for (const [_, watcher] of this.watchers) {
            watcher.dispose();
        }
        this.watchers.clear();
    }

    private createTestExeId(testExePath: string): string {
        return testidutil.createChildTestId(
            this.adapterId,
            util.stringHash(testExePath));
    }

    // If the adapter ID is present among the test IDs then
    // include all of the test-exe-ids into the list.
    // I.e. we want to include every test executable.
    private resolveAdapterItemsToTestExeItems(testItems: model.TestItem[]): model.TestItem[] {
        const resolvedTestItems: model.TestItem[] = [];
        for (const testItem of testItems) {
            if (testItem.id() === this.adapterId) {
                for (const [_, testExe] of this.testExecutables) {
                    if (!testExe.testItem) {
                        this.log.bug(`testExe.testItem is undefined for ${testExe.cfg.path}`);
                        continue;
                    }
                    resolvedTestItems.push(new model.TestItem(testExe.testItem, false));
                }
            } else {
                resolvedTestItems.push(testItem);
            }
        }
        return resolvedTestItems;
    }

    // Groups the test IDs by their test-exe-id component.
    // The test IDs have this format:
    // "test-exe-id/suite-1/suite-2/.../test-case"
    private groupTestItemsByTestExeId(testItems: model.TestItem[]): Map<string, model.TestItem[]> {
        const m: Map<string, model.TestItem[]> = new Map();
        for (const testItem of testItems) {
            const testExeId = testidutil.getTestExeId(testItem.id());
            if (m.has(testExeId)) {
                m.get(testExeId)!.push(testItem);
            } else {
                m.set(testExeId, [testItem]);
            }
        }
        return m;
    }

    private getTestExeOf(testItem: vscode.TestItem): TestExecutable | undefined {
        return this.testExecutables.get(testidutil.getTestExeId(testItem.id));
    }
}
