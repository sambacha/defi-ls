/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import {
	createConnection,
	TextDocuments,
	Diagnostic,
	DiagnosticSeverity,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	CompletionItem,
	CompletionItemKind,
	TextDocumentPositionParams,
	TextDocumentSyncKind,
	InitializeResult,
	CodeLens,
	CodeLensParams,
	CodeAction,
	CodeActionKind,
	CodeActionParams,
	CodeActionContext,
	Command,
	WorkspaceEdit,
	HoverParams,
	Hover,
	MarkedString,
	MarkupContent,
	MarkupKind
} from 'vscode-languageserver';

import {
	TextDocument, Range, TextEdit
} from 'vscode-languageserver-textdocument';

// Create a connection for the server. The connection uses Node's IPC as a transport.
// Also include all preview / proposed LSP features.
let connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager. The text document manager
// supports full document sync only
let documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;
let hasDiagnosticRelatedInformationCapability: boolean = false;

const NAME: string = 'DeFi Language Support';

const DIAGNOSTIC_TYPE_NOT_VALID_ADDRESS: string = 'NotValidAddress';
const DIAGNOSTIC_TYPE_NOT_CHECKSUM_ADDRESS: string = 'NotChecksumAddress';
const DIAGNOSTIC_TYPE_CONVERT_ENS_NAME: string = 'ConvertENSName';

const CODE_LENS_TYPE_ETH_ADDRESS: string = 'EthAddress';
const CODE_LENS_TYPE_ETH_PRIVATE_KEY: string = 'EthPrivateKey';

const MAINNET: string = 'mainnet';
const ROPSTEN: string = 'ropsten';
const KOVAN: string = 'kovan';
const RINKEBY: string = 'rinkeby';
const GOERLI: string = 'goerli';
const NETWORKS : string[] = [ MAINNET, ROPSTEN, KOVAN, RINKEBY, GOERLI];

var Web3 = require('web3');
var web3 = new Web3();
var ENS = require('ethereum-ens');
var Wallet = require('ethereumjs-wallet')
var EthUtil = require('ethereumjs-util')
const {indexOfRegex, lastIndexOfRegex} = require('index-of-regex')
var request = require("request-promise")
var BigNumber = require('big-number');

// to be defined at runtime
var web3provider: any;
var ens: { 
	resolver: (arg0: string) => { (): any; new(): any; addr: { (): Promise<any>; new(): any; }; };
	 reverse: (arg0: string) => { (): any; new(): any; name: { (): Promise<any>; new(): any; }; };  
};
var amberdataApiKeySetting: string;

connection.onInitialize((params: InitializeParams) => {
	let capabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	// If not, we will fall back using global settings
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);
	hasDiagnosticRelatedInformationCapability = !!(
		capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation
	);

	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Full,
			// Tell the client that the server supports code completion
			completionProvider: {
				resolveProvider: true
			},
			codeLensProvider : {
				resolveProvider: true
			},
			codeActionProvider : {
				codeActionKinds : [ CodeActionKind.QuickFix ]
			},
			hoverProvider : {
				workDoneProgress: false
			}
		}
	};
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true
			}
		};
	}
	return result;
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.log('Workspace folder change event received.');
		});
	}
});

interface DefiSettings {
	maxNumberOfProblems: number;
	infuraProjectId: string;
	infuraProjectSecret: string;
	amberdataApiKey: string;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: DefiSettings = { maxNumberOfProblems: 1000, infuraProjectId: "", infuraProjectSecret: "", amberdataApiKey: "" };
let globalSettings: DefiSettings = defaultSettings;

// Cache the settings of all open documents
let documentSettings: Map<string, Thenable<DefiSettings>> = new Map();

connection.onDidChangeConfiguration(change => {
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		documentSettings.clear();
	} else {
		globalSettings = <DefiSettings>(
			(change.settings.defi || defaultSettings)
		);
	}

	// Revalidate all open text documents
	documents.all().forEach(validateTextDocument);
});

function getDocumentSettings(resource: string): Thenable<DefiSettings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}
	let result = documentSettings.get(resource);
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: 'defi'
		});
		documentSettings.set(resource, result);
	}
	return result;
}

// Only keep settings for open documents
documents.onDidClose(e => {
	documentSettings.delete(e.document.uri);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
	validateTextDocument(change.document);
});

async function validateTextDocument(textDocument: TextDocument): Promise<void> {

	// In this simple example we get the settings for every validate run.
	let settings = await getDocumentSettings(textDocument.uri);

	if (settings.infuraProjectId === "" || settings.infuraProjectId === "") {
		connection.console.error("Infura project ID and/or secret has not been set. Obtain them from https://infura.io/ and set the in the VS Code settings by searching for \"Infura\".");
	} else {
		// set up infura and ENS
		web3provider = new Web3.providers.HttpProvider('https://:' + settings.infuraProjectSecret + '@mainnet.infura.io/v3/' + settings.infuraProjectId);
		ens = new ENS(web3provider);
	}

	if (settings.amberdataApiKey === "") {
		connection.console.warn("Amberdata.io API key has not been set. Obtain one from https://amberdata.io/ and set the in the VS Code settings by searching for \"Amberdata\".");
	} else {
		amberdataApiKeySetting = settings.amberdataApiKey;
	}

	let diagnostics: Diagnostic[] = [];

	let possibleEthereumAddresses : StringLocation[] = findPossibleEthereumAddresses(textDocument);
	let problems = 0;
	for (var i = 0; i < possibleEthereumAddresses.length; i++) {
		let element : StringLocation = possibleEthereumAddresses[i];
		if (problems < settings.maxNumberOfProblems) {
			problems++;
			if (!isValidEthereumAddress(element.content)) {
				// Invalid checksum
				addDiagnostic(element, `${element.content} is not a valid Ethereum address`, 'The string appears to be an Ethereum address but fails checksum.', DiagnosticSeverity.Error, DIAGNOSTIC_TYPE_NOT_VALID_ADDRESS);
			} else {
				// Not a checksum address
				var checksumAddress = web3.utils.toChecksumAddress(element.content);
				if (element.content != checksumAddress) {
					addDiagnostic(element, `${element.content} is not a checksum address`, 'Use a checksum address as a best practice to ensure the address is valid.', DiagnosticSeverity.Warning, DIAGNOSTIC_TYPE_NOT_CHECKSUM_ADDRESS + checksumAddress);
				}

				// Hint to convert to ENS name
				let ensName : string = await reverseENSLookup(element.content);
				if (ensName !== "") {
					addDiagnostic(element, `${element.content} can be converted to its ENS name \"${ensName}\"`, 'Convert the Ethereum address to its ENS name for better readability.', DiagnosticSeverity.Hint, DIAGNOSTIC_TYPE_CONVERT_ENS_NAME + ensName);
				}
			}
		}
	}

	// Send the computed diagnostics to VSCode.
	connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });

	function addDiagnostic(element: StringLocation, message: string, details: string, severity: DiagnosticSeverity, code: string | undefined) {
		let diagnostic: Diagnostic = {
			severity: severity,
			range: element.range,
			message: message,
			source: NAME,
			code: code
		};
		if (hasDiagnosticRelatedInformationCapability) {
			diagnostic.relatedInformation = [
				{
					location: {
						uri: textDocument.uri,
						range: Object.assign({}, diagnostic.range)
					},
					message: details
				}
			];
		}
		diagnostics.push(diagnostic);
	}
}

connection.onDidChangeWatchedFiles(_change => {
	// Monitored files have change in VSCode
	connection.console.log('We received an file change event');
});

export interface Token {
	name: string;
	symbol: string;
	address: string;
	marketCap: string;
	price: string;
	totalSupply: string;
	tradeVolume: string;
	uniqueAddresses: string | undefined;
}

async function getTopTokens() {
	let tokens : Token[] = []
	if (amberdataApiKeySetting !== "") {
		// Get top tokens by marketcap
		var options = {
			method: 'GET',
			url: 'https://web3api.io/api/v2/tokens/rankings',
			qs: {direction: 'descending', sortType: 'marketCap', timeInterval: 'days'},
			headers: {'x-api-key': amberdataApiKeySetting}
		  };

		await request(options, async function (error: string | undefined, response: any, body: any) {
			if (error) {
				connection.console.log("Request error getting top tokens: " + error);
				return;
			}
			var result = JSON.parse(body);
			if (result !== undefined && result.payload !== undefined && result.payload.data !== undefined && result.payload.data.length > 0) {
				result.payload.data.forEach((element: { name: any; symbol: any; address: any; marketCap: any; currentPrice: any; totalSupply: any; tradeVolume: any; uniqueAddresses: any}) => {
					let token : Token = {
						name: element.name,
						symbol: element.symbol,
						address: element.address,
						marketCap: element.marketCap,
						price: element.currentPrice,
						totalSupply: element.totalSupply,
						tradeVolume: element.tradeVolume,
						uniqueAddresses: element.uniqueAddresses
					}
					tokens.push(token)
				});
			}
		}).catch((error: string) => { connection.console.log("Error getting top tokens: " + error) });
	}
	return tokens;
}

// This handler provides the initial list of the completion items.
connection.onCompletion(
	async (_textDocumentPosition: TextDocumentPositionParams): Promise<CompletionItem[]> => {
		// The passed parameter contains the position of the text document in
		// which code complete got requested.

		let completionItems : CompletionItem[] = [];

		// Token completion items
		let tokens : Token[] = await getTopTokens();
		for (var i=0; i<tokens.length; i++) {
			let token = tokens[i];
			let textEdit : TextEdit = { 
				range: {
					start: _textDocumentPosition.position,
					end: _textDocumentPosition.position
				},  
				newText: getChecksumAddress(token.address)
			};
			let completionItem : CompletionItem = 
			{
				label: `Token: ${token.name} (${token.symbol})`,
				kind: CompletionItemKind.Value,
				data: token,
				textEdit: textEdit
			}			
			completionItems.push(completionItem);
		}

		// Snippets
		// Uniswap token
		{
			let snippet : string = 
				"const token = new Token(ChainId.MAINNET, '0xc0FFee0000000000000000000000000000000000', 18, 'HOT', 'Caffeine')\n";
			let imports = "import { ChainId, Token, TokenAmount, Pair, TradeType, Route } from '@uniswap/sdk'\n";
			insertSnippet(_textDocumentPosition, snippet, completionItems, imports, "DeFi: Uniswap token", 0);
		}
		// Uniswap pair
		{
			let snippet : string = 
				"const HOT = new Token(ChainId.MAINNET, '0xc0FFee0000000000000000000000000000000000', 18, 'HOT', 'Caffeine')\n"+
				"const NOT = new Token(ChainId.MAINNET, '0xDeCAf00000000000000000000000000000000000', 18, 'NOT', 'Caffeine')\n"+
				"\n"+
				"const pair = new Pair(new TokenAmount(HOT, '2000000000000000000'), new TokenAmount(NOT, '1000000000000000000'))\n";
			let imports = "import { ChainId, Token, TokenAmount, Pair, TradeType, Route } from '@uniswap/sdk'\n";
			insertSnippet(_textDocumentPosition, snippet, completionItems, imports, "DeFi: Uniswap pair", 1);
		}
		// Uniswap route
		{
			let snippet : string = 
				"const HOT = new Token(ChainId.MAINNET, '0xc0FFee0000000000000000000000000000000000', 18, 'HOT', 'Caffeine')\n"+
				"const NOT = new Token(ChainId.MAINNET, '0xDeCAf00000000000000000000000000000000000', 18, 'NOT', 'Caffeine')\n"+
				"const HOT_NOT = new Pair(new TokenAmount(HOT, '2000000000000000000'), new TokenAmount(NOT, '1000000000000000000'))\n"+
				"\n"+
				"const route = new Route([HOT_NOT], NOT)\n";
			let imports = "import { ChainId, Token, TokenAmount, Pair, TradeType, Route } from '@uniswap/sdk'\n";
			insertSnippet(_textDocumentPosition, snippet, completionItems, imports, "DeFi: Uniswap route", 2);
		}
		// Uniswap trade
		{
			let snippet : string = 
				"const HOT = new Token(ChainId.MAINNET, '0xc0FFee0000000000000000000000000000000000', 18, 'HOT', 'Caffeine')\n"+
				"const NOT = new Token(ChainId.MAINNET, '0xDeCAf00000000000000000000000000000000000', 18, 'NOT', 'Caffeine')\n"+
				"const HOT_NOT = new Pair(new TokenAmount(HOT, '2000000000000000000'), new TokenAmount(NOT, '1000000000000000000'))\n"+
				"const NOT_TO_HOT = new Route([HOT_NOT], NOT)\n"+
				"\n"+
				"const trade = new Trade(NOT_TO_HOT, new TokenAmount(NOT, '1000000000000000'), TradeType.EXACT_INPUT)\n";
			let imports = "import { ChainId, Token, TokenAmount, Pair, TradeType, Route } from '@uniswap/sdk'\n";
			insertSnippet(_textDocumentPosition, snippet, completionItems, imports, "DeFi: Uniswap trade", 3);
		}
		// pTokens
		{
			let snippet : string = 
				"const ptokens = new pTokens({\n"+
				"	pbtc: {\n"+
				"		ethPrivateKey: 'Eth private key',\n"+
				"		ethProvider: 'Eth provider',\n"+
				"		btcNetwork: 'testnet',  //'testnet' or 'bitcoin', default 'testnet'\n"+
				"		defaultEndpoint: 'https://......' //optional\n"+
				"	}\n"+
				"})\n";
			let imports = "import pTokens from 'ptokens'\n";
			insertSnippet(_textDocumentPosition, snippet, completionItems, imports, "DeFi: pTokens", 4);
		}
		// pTokens (web3)
		{
			let snippet : string = 
				"if (window.web3) {\n"+
				"	const ptokens = new pTokens({\n"+
				"		pbtc: {\n"+
				"			ethProvider: window.web3.currentProvider,\n"+
				"			btcNetwork: 'bitcoin'\n"+
				"		}\n"+
				"	})\n"+
				"} else {\n"+
				"	console.log('No web3 detected')\n"+
				"}\n";
			let imports = "import pTokens from 'ptokens'\n";
			insertSnippet(_textDocumentPosition, snippet, completionItems, imports, "DeFi: pTokens (web3)", 5);
		}
		// pTokens (pBTC deposit address)
		{
			let snippet : string = 
				"const depositAddress = await ptokens.pbtc.getDepositAddress(ethAddress)\n"+
				"console.log(depositAddress.toString())\n"+
				"\n"+
				"//fund the BTC address just generated (not ptokens.js stuff)\n"+
				"\n"+
				"depositAddress.waitForDeposit()\n"+
				"	.once('onBtcTxBroadcasted', tx => ... )\n"+
				"	.once('onBtcTxConfirmed', tx => ...)\n"+
				"	.once('onNodeReceivedTx', tx => ...)\n"+
				"	.once('onNodeBroadcastedTx', tx => ...)\n"+
				"	.once('onEthTxConfirmed', tx => ...)\n"+
				"	.then(res => ...))\n";
			let imports = "import pTokens from 'ptokens'\n";
			insertSnippet(_textDocumentPosition, snippet, completionItems, imports, "DeFi: pTokens (pBTC deposit address)", 6);
		}


		return completionItems;
	}
);

function insertSnippet(_textDocumentPosition: TextDocumentPositionParams, snippetText: string, completionItems: CompletionItem[], imports: string | undefined, label: string, sortOrder: number) {
	let textEdit: TextEdit = {
		range: {
			start: _textDocumentPosition.position,
			end: _textDocumentPosition.position
		},
		newText: snippetText
	};
	let completionItem: CompletionItem = {
		label: label,
		kind: CompletionItemKind.Snippet,
		data: undefined,
		textEdit: textEdit,
		sortText: String(sortOrder)
	};
	// check if imports should be added
	let textDocument = documents.get(_textDocumentPosition.textDocument.uri)
	let textDocumentContents = textDocument?.getText()
	if (imports !== undefined && (textDocumentContents === undefined || !String(textDocumentContents).includes(imports))) {
		let additionalTextEdit = {
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 0 }
			},
			newText: imports
		};
		completionItem.additionalTextEdits = [additionalTextEdit]
	}

	completionItems.push(completionItem);
}

function getChecksumAddress(address: string) {
	try {
		return web3.utils.toChecksumAddress(address)
	} catch(e) {
		connection.console.log("Error getting checksum address: " + e);
		return address;
	}
}

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
	(item: CompletionItem): CompletionItem => {
		if (<Token>item.data !== undefined) {
			let token : Token = item.data;
			item.detail = `${token.address}`;
			let markdown : MarkupContent = {
				kind: MarkupKind.Markdown,
				value: 
					getMarkdownForToken(token)
			};
			item.documentation = markdown;
		}
		return item;
	}
);

export interface StringLocation {
    range: Range;
    content: string;
}

function getMarkdownForToken(token: Token): string {
	var buf = `**Token: ${token.name} (${token.symbol})**\n\n` +
		`**Price:** \$${Number(token.price).toFixed(2)} USD  \n` +
		`**Market Cap:** \$${Number(token.marketCap).toFixed(2)} USD  \n` +
		`**Total Supply:** ${Number(token.totalSupply).toFixed(0)}  \n`;
	if (token.uniqueAddresses !== undefined) {
		buf += `**Unique Addresses (Daily):** ${Number(token.uniqueAddresses).toFixed(0)}  \n`;
	}
	buf += `**Trading Volume (Daily):** \$${Number(token.tradeVolume).toFixed(2)} USD  \n`;
	return buf;
}

// find all possible Ethereum addresses
function findPossibleEthereumAddresses(textDocument: TextDocument) : StringLocation[] {
	let text = textDocument.getText();
	let pattern = /0x[0-9a-fA-F]{40}\b/g;  // 0x then 40 hex chars then non hex char
	let m: RegExpExecArray | null;

	let problems = 0;
	let locations: StringLocation[] = [];
	while ((m = pattern.exec(text)) && problems < 100 /*settings.maxNumberOfProblems*/) {
		let location: StringLocation = {
			range: {
				start: textDocument.positionAt(m.index),
				end: textDocument.positionAt(m.index + m[0].length)
			},
			content: m[0] // Possible location
		};
		locations.push(location);
	}
	return locations;
}

function isValidEthereumAddress(address: string) {
	return web3.utils.isAddress(address)
}

function findPossiblePrivateKeys(textDocument: TextDocument) : StringLocation[] {
	let text = textDocument.getText();
	let pattern = /[0-9a-fA-F]{64}\b/g;  // 64 hex chars then non hex char
	let m: RegExpExecArray | null;

	let problems = 0;
	let locations: StringLocation[] = [];
	while ((m = pattern.exec(text)) && problems < 100 /*settings.maxNumberOfProblems*/) {
		let location: StringLocation = {
			range: {
				start: textDocument.positionAt(m.index),
				end: textDocument.positionAt(m.index + m[0].length)
			},
			content: normalizeHex(m[0]) // 0x prepended private key
		};
		locations.push(location);
	}
	return locations;
}

function isPrivateKey(possiblePrivateKey: string) {
	try {
		var privateKeyBuffer = EthUtil.toBuffer(possiblePrivateKey)
		Wallet.fromPrivateKey(privateKeyBuffer)
	} catch(e) {
		return false;
	}
	return true;
}

// append 0x to the front of a hex string if it doesn't start with it
function normalizeHex(hex:string) : string {
	if (!hex.startsWith("0x")) {
		return "0x" + hex;
	}
	return hex;
}

function toPublicKey(privateKey: string) : string {
	return web3.eth.accounts.privateKeyToAccount(privateKey).address;
}

// Handle code lens requests
connection.onCodeLens(
	(_params: CodeLensParams): CodeLens[] => {
		let textDocument = documents.get(_params.textDocument.uri)
		if (typeof textDocument !== 'undefined') {
			let codeLenses: CodeLens[] = [];

			// Ethereum addresses
			let possibleEthereumAddresses : StringLocation[] = findPossibleEthereumAddresses(textDocument);
			possibleEthereumAddresses.forEach( (element) => {
				if (isValidEthereumAddress(element.content)) {
					pushEthereumAddressCodeLenses(CODE_LENS_TYPE_ETH_ADDRESS, element.range, element.content, codeLenses);
				}
			});

			// Private keys to public addresses
			let possiblePublicKeys : StringLocation[] = findPossiblePrivateKeys(textDocument);
			possiblePublicKeys.forEach( (element) => {
				if (isPrivateKey(element.content)) {
					pushEthereumAddressCodeLenses(CODE_LENS_TYPE_ETH_PRIVATE_KEY, element.range, toPublicKey(element.content), codeLenses);
				}
			});

			// return
			return codeLenses;
		} else {
			return [];
		}
	}
);

function pushEthereumAddressCodeLenses(codeLensType: string, range: Range, content: string, codeLenses: CodeLens[]) {
	NETWORKS.forEach( (network) => {
		let codeLens: CodeLens = { 
			range: range, 
			data: [codeLensType, network, content] 
		};
		codeLenses.push(codeLens);	
	});
}

connection.onCodeLensResolve(
	async (codeLens: CodeLens): Promise<CodeLens> => {
		let codeLensType = codeLens.data[0];
		let network = codeLens.data[1];
		let codeLensData = codeLens.data[2];
		let address : string = codeLensData.toString();
		if (network === MAINNET) {
			// reverse ENS lookup
			let ensName : string = await reverseENSLookup(address);
			// token lookup
			let token : Token | undefined = await getToken(address);
			
			let prefix = "";
			if (ensName != "") {
				prefix += ensName + " | ";
			}
			let isToken : boolean = false;
			if (token !== undefined) {
				isToken = true;
				prefix += getTokenName(token) + " | ";
			}

			if (codeLensType === CODE_LENS_TYPE_ETH_ADDRESS) {
				codeLens.command = Command.create(prefix + "Ethereum " + (isToken?"token":"address") + " (mainnet): " + address, "etherscan.show.url", "https://etherscan.io/address/" + address);
			} else if (codeLensType === CODE_LENS_TYPE_ETH_PRIVATE_KEY) {
				codeLens.command = Command.create(prefix + "Private key for Ethereum " + (isToken?"token":"address") + " (mainnet): " + address, "etherscan.show.url", "https://etherscan.io/address/" + address);
			}	
		} else if (network === ROPSTEN) {
			codeLens.command = Command.create("(ropsten)", "etherscan.show.url", "https://ropsten.etherscan.io/address/" + address);
		} else if (network === KOVAN) {
			codeLens.command = Command.create("(kovan)", "etherscan.show.url", "https://kovan.etherscan.io/address/" + address);
		} else if (network === RINKEBY) {
			codeLens.command = Command.create("(rinkeby)", "etherscan.show.url", "https://rinkeby.etherscan.io/address/" + address);
		} else if (network === GOERLI) {
			codeLens.command = Command.create("(goerli)", "etherscan.show.url", "https://goerli.etherscan.io/address/" + address);
		}
		return codeLens;
	}
);

function getTokenName(token : Token) {
	return `${token.name} (${token.symbol})`;
}

connection.onCodeAction(
	(_params: CodeActionParams): CodeAction[] => {
		let codeActions : CodeAction[] = [];

		let textDocument = documents.get(_params.textDocument.uri)
		if (textDocument === undefined) {
			return codeActions;
		}
		let context : CodeActionContext = _params.context;
		let diagnostics : Diagnostic[] = context.diagnostics;

		codeActions = getCodeActions(diagnostics, textDocument, _params);

		return codeActions;
	}
)

async function reverseENSLookup(address: string) {
	let result = "";
	await ens.reverse(address).name().then(async function (name: string) {
		connection.console.log("Found ENS name for " + address + " is: " + name);
		// then forward ENS lookup to validate
		let addr = await ENSLookup(name);
		if (web3.utils.toChecksumAddress(address) == web3.utils.toChecksumAddress(addr)) {
			result = name;
		}
	}).catch(e => connection.console.log("Could not reverse lookup ENS name for " + address + " due to error: " + e));
	return result;
}

async function ENSLookup(name: string) {
	let result = "";
	await ens.resolver(name).addr().then(function (addr: string) {
		connection.console.log("ENS resolved address is " + addr);
		if (addr != "0x0000000000000000000000000000000000000000") {
			result = addr;
		}
	}).catch(e => connection.console.log("Could not do lookup ENS address for resolved name " + name + " due to error: " + e));
	return result;
}

function getCodeActions(diagnostics: Diagnostic[], textDocument: TextDocument, params: CodeActionParams) : CodeAction[] {
	let codeActions : CodeAction[] = [];

	// Get quick fixes for each diagnostic
	diagnostics.forEach( (diagnostic) => {
		if (String(diagnostic.code).startsWith(DIAGNOSTIC_TYPE_NOT_CHECKSUM_ADDRESS)) {
			let title : string = "Convert to checksum address";
			let range : Range = diagnostic.range;
			let replacement : string = String(diagnostic.code).substring(DIAGNOSTIC_TYPE_NOT_CHECKSUM_ADDRESS.length);
			codeActions.push(getQuickFix(diagnostic, title, range, replacement, textDocument));
		} else if (String(diagnostic.code).startsWith(DIAGNOSTIC_TYPE_CONVERT_ENS_NAME)) {
			let replacement : string = String(diagnostic.code).substring(DIAGNOSTIC_TYPE_CONVERT_ENS_NAME.length);
			let title : string = `Convert to ENS name \"${replacement}\"`;
			let range : Range = diagnostic.range;
			codeActions.push(getQuickFix(diagnostic, title, range, replacement, textDocument));
		}
	});

	return codeActions;
}

function getQuickFix(diagnostic:Diagnostic, title:string, range:Range, replacement:string, textDocument:TextDocument) : CodeAction {
	let textEdit : TextEdit = { 
		range: range,
		newText: replacement
	};
	let workspaceEdit : WorkspaceEdit = {
		changes: { [textDocument.uri]:[textEdit] }
	}
	let codeAction : CodeAction = { 
		title: title, 
		kind: CodeActionKind.QuickFix,
		edit: workspaceEdit,
		diagnostics: [diagnostic]
	}
	return codeAction;
}

connection.onHover(

	async (_params: HoverParams): Promise<Hover> => {
		let textDocument = documents.get(_params.textDocument.uri)
		let position = _params.position
		let hover : Hover = {
			contents: ""
		}
		if (textDocument !== undefined) {
			var start = {
				line: position.line,
				character: 0,
			};
			var end = {
				line: position.line + 1,
				character: 0,
			};
			var text = textDocument.getText({ start, end });
			var index = textDocument.offsetAt(position) - textDocument.offsetAt(start);
			var word = getWord(text, index);

			let buf : MarkedString = "";
			if (isValidEthereumAddress(word)) {
				// Display Ethereum address, ENS name, mainnet ETH and DAI balances
				buf = await getHoverMarkdownForAddress(word);
			} else {
				let normalized = normalizeHex(word);
				if (isPrivateKey(normalized)) {
					// Convert to public key then display
					buf = await getHoverMarkdownForAddress(toPublicKey(normalized));
				} else {
					// If it's not a private key, check if it has an ENS name
					let address = await ENSLookup(word);
					if (address != "") {
						buf = await getHoverMarkdownForAddress(address);
					}
				}
			}
			hover.contents = buf;
		}
		return hover;
	}
	
);

async function getHoverMarkdownForAddress(address: string) {
	var result = await getMarkdownForTokenAddress(address)
	if (result === "") {
		result = await getMarkdownForRegularAddress(address)
	}
	return result;
}

async function getToken(address: string) {
	let token : Token | undefined = undefined;
	if (amberdataApiKeySetting !== "") {
		// Get top tokens by marketcap
		var options = {
			method: 'GET',
			url: 'https://web3api.io/api/v2/market/tokens/prices/'+address+'/latest',
			headers: {'x-api-key': amberdataApiKeySetting}
		};

		await request(options, async function (error: string | undefined, response: any, body: any) {
			if (error) {
				connection.console.log("Request error while getting token: " + error);
				return;
			}
			var result = JSON.parse(body);
			if (result !== undefined && result.payload !== undefined && result.payload.length > 0 && result.payload[0] !== undefined) {
				let element = result.payload[0];
				token = {
					name: element.name,
					symbol: element.symbol,
					address: element.address,
					marketCap: element.marketCapUSD,
					price: element.priceUSD,
					totalSupply: element.totalSupply,
					tradeVolume: element.dailyVolumeUSD,
					uniqueAddresses: element.uniqueAddresses
				}
			}
		}).catch((error: string) => { connection.console.log("Error getting token: " + error) });
	}
	return token;
}

async function getMarkdownForTokenAddress(address: string) {
	let token : Token | undefined = await getToken(address);
	if (token !== undefined) {
		return getMarkdownForToken(token);
	}
	return "";
}

async function getMarkdownForRegularAddress(address: string) {
	let buf: MarkedString = "**Ethereum Address**: " + address + "\n\n";
	// reverse ENS lookup
	let ensName: string = await reverseENSLookup(address);
	if (ensName != "") {
		buf += "**ENS Name**: " + ensName + "\n\n";
	}
	var web3connection = new Web3(web3provider);
	let balance = await web3connection.eth.getBalance(address);
	if (balance > 0) {
		buf += "**Ether Balance**:\n\n"
		    + "    " + web3.utils.fromWei(balance) + " ETH";
	}
	
	// Get ETH value and token balances using Amberdata.io APIs
	if (amberdataApiKeySetting !== "") {

		// ETH value and price
		var options1 = {
			method: 'GET',
			url: 'https://web3api.io/api/v2/addresses/'+address+'/account-balances/latest',
			qs: {includePrice: 'true', currency: 'usd'},
			headers: {
			  'x-amberdata-blockchain-id': 'ethereum-mainnet',
			  'x-api-key': amberdataApiKeySetting
			}
		};

		await request(options1, async function (error: string | undefined, response: any, body: any) {
			if (error) {
				connection.console.log("Request error getting ETH balance: " + error);
				return;
			}
			var result = JSON.parse(body);
			if (result !== undefined && result.payload !== undefined && result.payload.price !== undefined && result.payload.value !== undefined) {
				var total = result.payload.price.value.total;
				var quote = result.payload.price.value.quote;
				buf += " ($" + Number(total).toFixed(2) + " USD @ $" + Number(quote).toFixed(2) + ")";
			}
		}).catch((error: string) => { connection.console.log("Error getting ETH balance: " + error) });

		buf += "\n\n";

		// Token balances, values and price
		var options = {
			method: 'GET',
			url: 'https://web3api.io/api/v2/addresses/'+address+'/tokens',
			qs: {
			  direction: 'descending',
			  includePrice: 'true',
			  currency: 'usd',
			  sortType: 'amount',
			  page: '0',
			  size: '5'
			},
			headers: {
				'x-amberdata-blockchain-id': 'ethereum-mainnet',
				'x-api-key': amberdataApiKeySetting
			}
		};
	
		await request(options, async function (error: string | undefined, response: any, body: any) {
			if (error) {
				connection.console.log("Request error getting token balances: " + error);
				return;
			}
			var result = JSON.parse(body);
			if (result !== undefined && result.payload !== undefined && result.payload.records !== undefined && result.payload.records.length > 0) {
				buf += "**Tokens**:\n\n";
				result.payload.records.forEach((element: {
					symbol: any;
					amount: any;
					decimals: any;
					price: {
						amount: {
							quote: any;
							total: any;
						};
					};
				}) => {
					var symbol = element.symbol;
					var amount = BigNumber(element.amount).divide(BigNumber(10).power(BigNumber(element.decimals)));
					buf += "    " + amount + " " + symbol;
					if (element.price != null) {
						var quote = Number(element.price.amount.quote).toFixed(2);
						var totalValue = Number(element.price.amount.total).toFixed(2);
						buf += " ($" + totalValue + " USD @ $" + quote + ") \n";
					} else {
						buf += " \n";
					}
				});
			}
		}).catch((error: string) => { connection.console.log("Error getting token balances: " + error) });

	}
	return buf;
}

async function getTokenBalance(walletAddress:string, tokenAddress:string) {
	
	// The minimum ABI to get ERC20 Token balance
	let minABI = [
	  // balanceOf
	  {
		"constant":true,
		"inputs":[{"name":"_owner","type":"address"}],
		"name":"balanceOf",
		"outputs":[{"name":"balance","type":"uint256"}],
		"type":"function"
	  },
	  // decimals
	  {
		"constant":true,
		"inputs":[],
		"name":"decimals",
		"outputs":[{"name":"","type":"uint8"}],
		"type":"function"
	  }
	];
	
	var web3connection = new Web3(web3provider);
	let contract = new web3connection.eth.Contract(minABI, tokenAddress);

	let balance = await contract.methods.balanceOf(walletAddress).call();
	connection.console.log("Token balance " + balance);
	return balance;
}

function getWord(text: string, index: number) {
	var beginSubstring = text.substring(0, index);

	var endSubstring = text.substring(index, text.length);
	var boundaryRegex = /[^0-9a-zA-Z.]{1}/g; // boundaries are: not alphanumeric or dot
    var first = lastIndexOfRegex(beginSubstring, boundaryRegex) + 1;
	var last = index + indexOfRegex(endSubstring, boundaryRegex);

	return text.substring(first !== -1 ? first : 0, last !== -1 ? last : text.length - 1);
}

/*
connection.onDidOpenTextDocument((params) => {
	// A text document got opened in VSCode.
	// params.textDocument.uri uniquely identifies the document. For documents store on disk this is a file URI.
	// params.textDocument.text the initial full content of the document.
	connection.console.log(`${params.textDocument.uri} opened.`);
});
connection.onDidChangeTextDocument((params) => {
	// The content of a text document did change in VSCode.
	// params.textDocument.uri uniquely identifies the document.
	// params.contentChanges describe the content changes to the document.
	connection.console.log(`${params.textDocument.uri} changed: ${JSON.stringify(params.contentChanges)}`);
});
connection.onDidCloseTextDocument((params) => {
	// A text document got closed in VSCode.
	// params.textDocument.uri uniquely identifies the document.
	connection.console.log(`${params.textDocument.uri} closed.`);
});
*/

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
