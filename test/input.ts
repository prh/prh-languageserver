import { InitializeParams, DidOpenTextDocumentParams, CodeActionParams, ExecuteCommandParams } from "vscode-languageclient";
import { RequestMessage, NotificationMessage } from "vscode-jsonrpc";

import * as fs from "fs";

let seq = 0;
{
    const params: InitializeParams = {
        processId: process.pid,
        rootUri: process.cwd(),
        capabilities: {
            textDocument: {
                hover: {
                    dynamicRegistration: true,
                },
                codeAction: {
                    dynamicRegistration: true,
                },
            },
        },
        trace: "verbose",
    };
    const req: RequestMessage = {
        jsonrpc: "2.0",
        id: ++seq,
        method: "initialize",
        params: params,
    };

    const jsonStr = JSON.stringify(req);
    process.stdout.write(`Content-Length: ${jsonStr.length + 2}\r\n\r\n`);
    process.stdout.write(`${jsonStr}\r\n`);
}
{
    const content = fs.readFileSync("./fixture/test.txt", "utf8");
    const params: DidOpenTextDocumentParams = {
        textDocument: {
            uri: "./fixture/test.txt",
            languageId: "plaintext",
            version: 1,
            text: content,
        },
    };
    const req: NotificationMessage = {
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: params,
    };

    const jsonStr = JSON.stringify(req);
    process.stdout.write(`Content-Length: ${jsonStr.length + 2}\r\n\r\n`);
    process.stdout.write(`${jsonStr}\r\n`);
}
{
    const params: CodeActionParams = {
        textDocument: {
            uri: "./fixture/test.txt",
        },
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
        context: {
            diagnostics: [],
        },
    };
    const req: RequestMessage = {
        jsonrpc: "2.0",
        id: ++seq,
        method: "textDocument/codeAction",
        params: params,
    };

    const jsonStr = JSON.stringify(req);
    process.stdout.write(`Content-Length: ${jsonStr.length + 2}\r\n\r\n`);
    process.stdout.write(`${jsonStr}\r\n`);
}
{
    const params: ExecuteCommandParams = {
        command: "replace",
        arguments: [{
            uri: "./fixture/test.txt",
            version: 1,
            textEdit: {
                range: {
                    start: {
                        line: 0,
                        character: 0,
                    },
                    end: {
                        line: 0,
                        character: "javascript".length,
                    },
                },
                newText: "JavaScript",
            },
        }],
    };
    const req: RequestMessage = {
        jsonrpc: "2.0",
        id: ++seq,
        method: "workspace/executeCommand",
        params: params,
    };

    const jsonStr = JSON.stringify(req);
    process.stdout.write(`Content-Length: ${jsonStr.length + 2}\r\n\r\n`);
    process.stdout.write(`${jsonStr}\r\n`);
}
{
    const req: RequestMessage = {
        jsonrpc: "2.0",
        id: ++seq,
        method: "shutdown",
    };

    const jsonStr = JSON.stringify(req);
    process.stdout.write(`Content-Length: ${jsonStr.length + 2}\r\n\r\n`);
    process.stdout.write(`${jsonStr}\r\n`);
}
{
    const req: NotificationMessage = {
        jsonrpc: "2.0",
        method: "exit",
    };

    const jsonStr = JSON.stringify(req);
    process.stdout.write(`Content-Length: ${jsonStr.length + 2}\r\n\r\n`);
    process.stdout.write(`${jsonStr}\r\n`);
}
