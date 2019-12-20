import { createConnection, TextDocuments } from 'vscode-languageserver';
import { Handler } from './handler';

const connection = createConnection();
const documents = new TextDocuments();
documents.listen(connection);
const handler = new Handler(connection, documents);
handler.listen();
