import * as path from "path";
import { fromYAMLFilePath, Engine, ChangeSet, Diff } from "prh";

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
    configFile?: string;
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

// https://github.com/Microsoft/language-server-protocol/blob/master/protocol.md
export class Handler {
    engine: Engine;
    enable: boolean;
    configPath: string;
    workspaceRoot?: string | null;

    validationCache: { [uri: string]: ChangeSetCache | null; } = {};

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
        this.workspaceRoot = params.rootUri || params.rootPath;
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
        this.configPath = settings.prh.configFile || "prh.yml";

        this.loadConfig();
    }

    loadConfig() {
        this.connection.console.log(`loadConfig: ${this.configPath}`);

        this.validationCache = {};

        this.engine = fromYAMLFilePath(this.configPath);

        this.documents.all().forEach(document => this.sendValidationDiagnostics(document));
    }

    onDidChangeContent(change: TextDocumentChangeEvent) {
        this.sendValidationDiagnostics(change.document);
    }

    onDidChangeWatchedFiles(change: DidChangeWatchedFilesParams) {
        if (this.workspaceRoot == null) {
            return;
        }
        let configUri = Uri.parse(this.workspaceRoot);
        configUri = configUri.with({
            path: path.resolve(configUri.path, this.configPath),
        });

        const configChanged = change.changes.filter(change => change.uri === configUri.toString());
        if (configChanged) {
            this.loadConfig();
        }
    }

    documentValidate(textDocument: TextDocument): ChangeSet | null {
        if (!this.engine || !this.enable) {
            return null;
        }
        if (this.validationCache[textDocument.uri] && this.validationCache[textDocument.uri]!.version === textDocument.version) {
            return this.validationCache[textDocument.uri]!.changeSet;
        }
        this.validationCache[textDocument.uri] = null;

        const changeSet = this.engine.makeChangeSet(textDocument.uri, textDocument.getText());
        if (!changeSet) {
            return null;
        }
        this.validationCache[textDocument.uri] = {
            version: textDocument.version,
            changeSet,
        };

        return changeSet;
    }

    sendValidationDiagnostics(textDocument: TextDocument) {
        const changeSet = this.documentValidate(textDocument);
        if (!changeSet) {
            return;
        }

        const diagnostics: Diagnostic[] = changeSet.diffs.map(diff => {
            const start = textDocument.positionAt(diff.index);
            const end = textDocument.positionAt(diff.tailIndex);
            let message;
            if (diff.rule && diff.rule.raw && diff.rule.raw.prh) {
                message = `→${diff.expected || "??"} ${diff.rule.raw.prh}`;
            } else {
                message = `→${diff.expected || "??"}`;
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

        this.connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
    }

    onCodeAction(params: CodeActionParams): Command[] {
        const textDocument = this.documents.get(params.textDocument.uri);
        const changeSet = this.documentValidate(textDocument);
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
                        newText: diff.expected || diff.matches[0],
                    },
                };
                return {
                    title: `→ ${diff.expected}`,
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

    executeReplace(args: ExecuteCommandParams) {
        if (!args.arguments || !args.arguments[0]) {
            return;
        }
        const commandParams: ReplaceCommandParams = args.arguments[0];

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
        });
    }

    executeApplyAllQuickFixes(args: ExecuteCommandParams) {
        if (!args.arguments || !args.arguments[0]) {
            return;
        }

        const textDocument = this.documents.get(args.arguments[0]);
        const changeSet = this.documentValidate(textDocument);
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
        });
    }

    getTextEditFromDiff(textDocument: TextDocument, diff: Diff): TextEdit {
        const start = textDocument.positionAt(diff.index);
        const end = textDocument.positionAt(diff.tailIndex);
        return {
            range: { start, end },
            newText: diff.expected || diff.matches[0],
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
