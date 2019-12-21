import * as Diff from 'diff';
import * as fs from 'fs';
import * as assert from 'assert';
import {
    Readable,
    Writable,
    Transform,
    TransformCallback,
} from 'stream';
import { RequestMessage } from "vscode-jsonrpc";
import {
    createConnection,
    CodeActionParams,
    DidOpenTextDocumentParams,
    ExecuteCommandParams,
    InitializeParams,
    NotificationMessage,
    TextDocuments,
} from 'vscode-languageserver';
import { Handler } from '../lib/handler';

/**
 * 送信したリクエストを記録する配列。
 */
const sentRequests: any[] = [];

/**
 * JSON-RPCリクエスト用オブジェクトを受け取り、
 * Content-Lengthヘッダを付与して、入力ストリームへプッシュする。
 * @param reqObj {any}
 * @param input {Readable}
 */
function sendRequest(reqObj: any, input: Readable) {
    const body = JSON.stringify(reqObj);
    const head = `Content-Length: ${body.length + 2}`;
    const req = `${head}\r\n\r\n${body}\r\n`;
    input.push(req);
    sentRequests.push(req);
}

/**
 * 入力ストリーム。
 */
const input = new Readable();
input._read = () => { };

let actualOut = '';

/**
 * STDOUTへの出力とスナップショットへの記録を制御する
 * Transformストリーム。
 * 入力ストリームと出力ストリームの間にはさむ。
 */
const buffer: Transform = new Transform({
    transform(
        chunk: string | Buffer,
        encoding: string,
        done: TransformCallback
    ): void {
        const req = chunk.toString();
        // 送信したリクエストは標準出力にも出さずスナップショットにも記録しない
        if (sentRequests.indexOf(req) < 0) {
            actualOut += req;
            this.push(chunk);
            process.stdout.write(req);
        }
        done();
    }
});

/**
 * スナップショット記録用の出力ストリーム。
 */
let file: Writable;

const snapshotPath = __filename + '.snapshot.txt';
if (!fs.existsSync(snapshotPath) || process.env['UPDATE_SNAPSHOT'] === '1') {
    file = fs.createWriteStream(snapshotPath, {
        encoding: 'utf8',
        autoClose: true,
    });
    input.pipe(buffer).pipe(file);
} else {
    input.pipe(buffer);
}

/**
 * 今回の出力結果を記録済みスナップショットと比較する。
 * connection.onExit()に渡すイベントハンドラー。
 */
function exitHandler(): void {
    if (!fs.existsSync(snapshotPath)) {
        throw new Error(`${snapshotPath} does not exist!`);
    }

    const expectedOut = fs.readFileSync(snapshotPath, {
        encoding: 'utf8',
    });
    console.log();

    try {
        assert.equal(actualOut, expectedOut, 'Different from snapshot!');
        console.log('ok');
    } catch (err) {
        const title = 'Laugnage server responses';
        const patch = Diff.createPatch(title, expectedOut, actualOut, 'snapshot', 'current');
        console.log(patch);
        console.log('\n' + err.message);
    }
}

{
    const connection = createConnection(input, buffer);
    connection.onExit(exitHandler);
    const documents = new TextDocuments();
    documents.listen(connection);
    const handler = new Handler(connection, documents);
    handler.listen();
}

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
        workspaceFolders: null,
    };
    const req: RequestMessage = {
        jsonrpc: "2.0",
        id: ++seq,
        method: "initialize",
        params: params,
    };

    sendRequest(req, input);
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

    sendRequest(req, input);
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

    sendRequest(req, input);
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

    sendRequest(req, input);
}
{
    const req: RequestMessage = {
        jsonrpc: "2.0",
        id: ++seq,
        method: "shutdown",
    };

    sendRequest(req, input);
}
{
    const req: NotificationMessage = {
        jsonrpc: "2.0",
        method: "exit",
    };

    sendRequest(req, input);
}
