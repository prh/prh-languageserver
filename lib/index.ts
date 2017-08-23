import * as fs from "fs";

import { fromYAMLFilePaths, getRuleFilePath, Engine, ChangeSet, Diff } from "prh";

import Uri from "vscode-uri";
import {
    createConnection,
    TextDocuments, TextDocument, Diagnostic, DiagnosticSeverity, IConnection, TextDocumentChangeEvent,
    InitializeParams, InitializeResult, DidChangeConfigurationParams, DidChangeWatchedFilesParams,
    CodeActionParams, Command, ExecuteCommandParams, TextEdit,
} from "vscode-languageserver";

export interface Settings {
    prh: PrhSettings;
}

export interface PrhSettings {
    enable?: boolean;
    configFiles?: string[];
    trace?: {
        server?: "off" | "messages" | "verbose";
    };
}

export interface ReplaceCommandParams {
    uri: string;
    version: number;
    textEdit: TextEdit;
}

export interface ChangeSetCache {
    version: number;
    changeSet: ChangeSet;
}

const enum State {
    valid = "valid",
    invalid = "invalid",
}

// https://github.com/Microsoft/language-server-protocol/blob/master/protocol.md
export class Handler {
    enable: boolean;
    configPaths: string[] | null;

    state = State.valid;

    engineCache: { [concatenatedRulePaths: string]: Engine; } = {};
    validationCache: { [uri: string]: ChangeSetCache; } = {};

    constructor(public connection: IConnection, public documents: TextDocuments) {
        this.connection.onInitialize(arg => this.onInitialized(arg));
        this.connection.onDidChangeConfiguration(arg => this.onDidChangeConfiguration(arg));
        this.connection.onDidChangeWatchedFiles(arg => this.onDidChangeWatchedFiles(arg));
        this.connection.onCodeAction(arg => this.onCodeAction(arg));
        this.connection.onExecuteCommand(arg => this.onExecuteCommand(arg));

        this.documents.onDidChangeContent(arg => this.onDidChangeContent(arg));
    }

    listen() {
        this.connection.listen();
    }

    onInitialized(params: InitializeParams): InitializeResult {
        return {
            capabilities: {
                textDocumentSync: this.documents.syncKind,
                hoverProvider: false,
                completionProvider: void 0,
                signatureHelpProvider: void 0,
                definitionProvider: false,
                referencesProvider: false,
                documentHighlightProvider: false,
                documentSymbolProvider: false,
                workspaceSymbolProvider: false,
                codeActionProvider: true,
                codeLensProvider: void 0,
                documentFormattingProvider: false,
                documentRangeFormattingProvider: false,
                documentOnTypeFormattingProvider: void 0,
                renameProvider: false,
                documentLinkProvider: void 0,
                executeCommandProvider: {
                    commands: ["replace"],
                },
                experimental: false,
            },
        };
    }

    onDidChangeConfiguration(change: DidChangeConfigurationParams) {
        this.connection.console.log(`onDidChangeConfiguration: ${JSON.stringify(change, null, 2)}`);

        const settings = change.settings as Settings;
        this.enable = !!settings.prh.enable;
        this.configPaths = settings.prh.configFiles || [];

        this.checkConfig();
        this.documents.all().forEach(document => this.validateAndSendDiagnostics(document));
    }

    onDidChangeContent(change: TextDocumentChangeEvent) {
        this.validateAndSendDiagnostics(change.document);
    }

    onDidChangeWatchedFiles(change: DidChangeWatchedFilesParams) {
        this.connection.console.log(`onDidChangeWatchedFiles: ${JSON.stringify(change, null, 2)}`);

        // 設定ファイルのいずれかが変更されたらキャッシュを捨てる
        const configChanged = change.changes.some(change => {
            const uri = Uri.parse(change.uri);
            return Object.keys(this.engineCache).some(concatenatedRulePaths => {
                // 若干雑な条件だけど間違っててもさほど痛くないのでOK
                // rulePathはpwdからの相対パス表現なので注意
                const rulePaths = concatenatedRulePaths.split("|");
                return rulePaths.some(rulePath => {
                    if (uri.path.endsWith(rulePath)) {
                        this.connection.console.log(`matched: ${uri.path} - ${rulePath}`);
                        return true;
                    }
                    return false;
                });
            });
        });
        if (configChanged) {
            this.checkConfig();
            this.documents.all().forEach(document => this.validateAndSendDiagnostics(document));
        }
    }

    onCodeAction(params: CodeActionParams): Command[] {
        const textDocument = this.documents.get(params.textDocument.uri);
        const changeSet = this.makeChangeSet(textDocument);
        if (!changeSet) {
            return [];
        }

        return changeSet.diffs
            .filter(diff => {
                const index = textDocument.offsetAt(params.range.start);
                const tailIndex = textDocument.offsetAt(params.range.end);
                return diff.index === index && diff.tailIndex === tailIndex;
            })
            .map(diff => {
                const commandParams: ReplaceCommandParams = {
                    uri: textDocument.uri,
                    version: textDocument.version,
                    textEdit: {
                        range: params.range,
                        newText: diff.newText || "??",
                    },
                };
                return {
                    title: `→ ${diff.newText || "??"}`,
                    command: "replace",
                    arguments: [commandParams],
                };
            });
    }

    onExecuteCommand(args: ExecuteCommandParams) {
        switch (args.command) {
            case "replace":
                this.executeReplace(args);
                break;
            case "applyAllQuickFixes":
                this.executeApplyAllQuickFixes(args);
                break;
            default:
                this.connection.console.log(`Unknown command: ${args.command}`);
        }
    }

    invalidateCache() {
        this.engineCache = {};
        this.validationCache = {};
    }

    checkConfig() {
        this.configPaths = this.configPaths || [];
        this.connection.console.log(`loadConfig: ${this.configPaths.join(", ") || "implicit"}`);

        this.invalidateCache();

        for (let configPath of this.configPaths) {
            if (!fs.existsSync(configPath)) {
                this.connection.console.log(`rule file not exists: ${configPath}`);
                if (this.state !== State.invalid) {
                    this.connection.window.showWarningMessage(`prh: 指定された設定ファイルが見つかりません ${configPath}`);
                }
                this.state = State.invalid;
                this.documents.all().forEach(document => this.clearDiagnostics(document));
                return;
            }
        }
        this.state = State.valid;
    }

    makeChangeSet(textDocument: TextDocument): ChangeSet | null {
        if (!this.enable || this.state === State.invalid) {
            return null;
        }
        if (this.validationCache[textDocument.uri] && this.validationCache[textDocument.uri].version === textDocument.version) {
            return this.validationCache[textDocument.uri].changeSet;
        }
        delete this.validationCache[textDocument.uri];

        let configPaths: string[];
        if (this.configPaths && this.configPaths[0]) {
            configPaths = this.configPaths;
        } else {
            const contentUri = Uri.parse(textDocument.uri);
            if (contentUri.scheme !== "file") {
                return null;
            }
            let foundPath = getRuleFilePath(contentUri.path);
            if (!foundPath) {
                this.connection.console.log(`rule file not found for ${textDocument.uri}`);
                return null;
            }
            this.connection.console.log(`rule file found: ${foundPath}`);
            configPaths = [foundPath];
        }

        let engine = this.engineCache[configPaths.join("|")];
        if (!engine) {
            try {
                engine = fromYAMLFilePaths(...configPaths);
            } catch (e) {
                this.connection.console.error(e);
                if (e instanceof Error) {
                    this.connection.window.showErrorMessage(`prh: \`${e.message}\` from ${configPaths.join(" ,")}`);
                    return null;
                }
            }
            this.engineCache[configPaths.join("|")] = engine;
        }

        const changeSet = engine.makeChangeSet(textDocument.uri, textDocument.getText());
        if (!changeSet) {
            return null;
        }
        this.validationCache[textDocument.uri] = {
            version: textDocument.version,
            changeSet,
        };

        return changeSet;
    }

    makeDiagnostic(textDocument: TextDocument): Diagnostic[] | null {
        const changeSet = this.makeChangeSet(textDocument);
        if (!changeSet) {
            return null;
        }

        return changeSet.diffs.map(diff => {

            const start = textDocument.positionAt(diff.index);
            const end = textDocument.positionAt(diff.tailIndex);
            let message;
            this.connection.console.log(JSON.stringify(diff));
            diff.apply(textDocument.getText())
            if (diff.rule && diff.rule.raw && diff.rule.raw.prh) {
                message = `→${diff.newText || "??"} ${diff.rule.raw.prh}`;
            } else {
                message = `→${diff.newText || "??"}`;
            }
            return {
                severity: DiagnosticSeverity.Warning,
                range: {
                    start,
                    end,
                },
                message,
                source: "prh",
            };
        });
    }

    validateAndSendDiagnostics(textDocument: TextDocument) {
        const diagnostics = this.makeDiagnostic(textDocument);
        this.connection.sendDiagnostics({ uri: textDocument.uri, diagnostics: diagnostics || [] });
    }

    clearDiagnostics(textDocument: TextDocument) {
        this.connection.sendDiagnostics({ uri: textDocument.uri, diagnostics: [] });
    }

    executeReplace(args: ExecuteCommandParams) {
        if (!args.arguments || !args.arguments[0]) {
            return;
        }
        const commandParams: ReplaceCommandParams = args.arguments[0];
        this.connection.console.log(JSON.stringify(commandParams));

        const textDocument = this.documents.get(commandParams.uri);
        if (commandParams.version !== textDocument.version) {
            this.connection.console.log(`Replace, document version mismatch: expected: ${commandParams.version}, actual: ${textDocument.version}`);
            return;
        }

        this.connection.workspace.applyEdit({
            documentChanges: [{
                textDocument: {
                    uri: textDocument.uri,
                    version: textDocument.version,
                },
                edits: [commandParams.textEdit],
            }],
        }).then(result => {
            this.connection.console.log(`Apply edit: ${JSON.stringify(result)}`);
        }, e => {
            this.connection.console.error(`error on executeReplace: ${e}`)
        });
    }

    executeApplyAllQuickFixes(args: ExecuteCommandParams) {
        if (!args.arguments || !args.arguments[0]) {
            return;
        }

        const textDocument = this.documents.get(args.arguments[0]);
        const changeSet = this.makeChangeSet(textDocument);
        if (!changeSet) {
            return;
        }
        const edits = changeSet.diffs.map(diff => this.getTextEditFromDiff(textDocument, diff));
        this.connection.workspace.applyEdit({
            documentChanges: [{
                textDocument: {
                    uri: textDocument.uri,
                    version: textDocument.version,
                },
                edits,
            }],
        }).then(result => {
            this.connection.console.log(`Apply edit: ${JSON.stringify(result)}`);
        }, e => {
            this.connection.console.error(`error on executeApplyAllQuickFixes: ${e}`)
        });
    }

    getTextEditFromDiff(textDocument: TextDocument, diff: Diff): TextEdit {
        const start = textDocument.positionAt(diff.index);
        const end = textDocument.positionAt(diff.tailIndex);
        return {
            range: { start, end },
            newText: diff.newText || "??",
        };
    }
}

{
    const connection = createConnection();
    const documents = new TextDocuments();
    documents.listen(connection);
    const handler = new Handler(connection, documents);
    handler.listen();
}
