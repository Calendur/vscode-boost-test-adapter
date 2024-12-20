import * as vscode from 'vscode';
const path = require('path');
const crypto = require("crypto");

export function stringHash(s: string): string {
    return crypto.createHash("sha1").update(s).digest("hex");
}


const commandRegex = new RegExp(/\${command:(.*?)}/);
// detokenizeVariables is based on https://github.com/DominicVonk/vscode-variables
export async function detokenizeVariables(rawValue: string, recursive = false): Promise<string> {
    let workspaces = vscode.workspace.workspaceFolders;
    let workspace = vscode.workspace.workspaceFolders?.length ? vscode.workspace.workspaceFolders[0] : null;
    let activeFile = vscode.window.activeTextEditor?.document;
    let absoluteFilePath = activeFile?.uri.fsPath
    rawValue = rawValue.replace(/\${workspaceFolder}/g, workspace?.uri.fsPath ?? "");
    rawValue = rawValue.replace(/\${workspaceFolderBasename}/g, workspace?.name ?? "");
    rawValue = rawValue.replace(/\${file}/g, absoluteFilePath ?? "");
    let activeWorkspace = workspace;
    let relativeFilePath = absoluteFilePath;
    for (let workspace of workspaces ?? []) {
        if (absoluteFilePath?.replace(workspace.uri.fsPath, '') !== absoluteFilePath) {
            activeWorkspace = workspace;
            relativeFilePath = absoluteFilePath?.replace(workspace.uri.fsPath, '').substr(path.sep.length);
            break;
        }
    }
    rawValue = rawValue.replace(/\${fileWorkspaceFolder}/g, activeWorkspace?.uri.fsPath ?? "");
    rawValue = rawValue.replace(/\${relativeFile}/g, relativeFilePath ?? "");
    rawValue = rawValue.replace(/\${relativeFileDirname}/g, relativeFilePath?.substr(0, relativeFilePath.lastIndexOf(path.sep)) ?? "");
	if(!absoluteFilePath) return rawValue;
    let parsedPath = path.parse(absoluteFilePath);
    rawValue = rawValue.replace(/\${fileBasename}/g, parsedPath.base ?? "");
    rawValue = rawValue.replace(/\${fileBasenameNoExtension}/g, parsedPath.name ?? "");
    rawValue = rawValue.replace(/\${fileExtname}/g, parsedPath.ext ?? "");
    rawValue = rawValue.replace(/\${fileDirname}/g, parsedPath.dir.substr(parsedPath.dir.lastIndexOf(path.sep) + 1));
    rawValue = rawValue.replace(/\${cwd}/g, parsedPath.dir);
    rawValue = rawValue.replace(/\${pathSeparator}/g, path.sep);
    while (true) {
        const commandRegexResult = commandRegex.exec(rawValue);
        if (commandRegexResult && commandRegexResult.length == 2) {
            const commandResult = await vscode.commands.executeCommand(commandRegexResult[1], "") as string;
            rawValue = rawValue.replace(commandRegexResult[0], commandResult);
        } else {
            break;
        }
    }
    return rawValue;
}
