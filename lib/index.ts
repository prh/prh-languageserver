import {
    createConnection,
    TextDocuments, TextDocument, Diagnostic, DiagnosticSeverity,
} from "vscode-languageserver";

const connection = createConnection();
const documents = new TextDocuments();
documents.listen(connection);

// https://github.com/Microsoft/language-server-protocol/blob/master/protocol.md

let workspaceRoot: string | null | undefined;
connection.onInitialize(params => {
    workspaceRoot = params.rootUri || params.rootPath;
    return {
        capabilities: {
            textDocumentSync: documents.syncKind,
            hoverProvider: true,
            codeActionProvider: true,
        },
    };
});

documents.onDidChangeContent(change => {
    validateTextDocument(change.document);
});

interface Settings {
    prhLanguageService: PrhSettings;
}

interface PrhSettings {
}

connection.onDidChangeConfiguration(change => {
    let settings = change.settings as Settings;
    !!settings;
    documents.all().forEach(validateTextDocument);
});

function validateTextDocument(textDocument: TextDocument): void {
    let diagnostics: Diagnostic[] = [];
    diagnostics.push({
        severity: DiagnosticSeverity.Warning,
        range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 }
        },
        message: `Hi!`,
        source: "prh",
    });
    connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

connection.onDidChangeWatchedFiles(change => {
    connection.console.log(`File changed: ${change.changes.map(fe => fe.uri).join(", ")}`);
});

connection.onCodeAction((params) => {
    return [{
        title: "javascript → JavaScript",
        command: "replace",
        arguments: [params.textDocument.uri, "javascript", "JavaScript"],
    }];
});

connection.onExecuteCommand(args => {
    connection.console.log(`Execute command: ${JSON.stringify(args)}`);
    connection.workspace.applyEdit({
        documentChanges: [{
            textDocument: {
                uri: args.arguments![0],
                version: 1,
            },
            edits: [{
                range: {
                    start: {
                        line: 0,
                        character: 0,
                    },
                    end: {
                        line: 0,
                        character: 0,
                    },
                },
                newText: args.arguments![2] || "",
            }],
        }],
    })
        .then(args => {
            connection.console.log(`Apply edit: ${JSON.stringify(args)}`);
        });
});

connection.listen();
