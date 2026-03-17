let vscode;
try {
	vscode = require('vscode');
} catch {
	vscode = null;
}

const DEFAULT_RULE_SORT_ORDER = [':root', 'selector', '::pseudo', '@at-rule'];
const SELECTOR_LAYOUT_VALUES = new Set(['one-line', 'one-per-line', 'as-is']);

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
	if (!vscode) {
		throw new Error('banana sort: VS Code API is unavailable in this runtime.');
	}

	const disposable = vscode.commands.registerCommand('banana-sort.sortCss', async function () {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showErrorMessage('banana sort: No active editor found.');
			return;
		}

		const fullRange = new vscode.Range(
			editor.document.positionAt(0),
			editor.document.positionAt(editor.document.getText().length)
		);
		const hasSelection = !editor.selection.isEmpty;
		const targetRange = hasSelection ? editor.selection : fullRange;
		const originalText = editor.document.getText(targetRange);
		const trimmedInput = originalText.trim();

		if (!trimmedInput) {
			vscode.window.showWarningMessage('banana sort: Nothing to sort in the selected text.');
			return;
		}

		const options = await loadCssOptions();

		let sortedCss;
		try {
			sortedCss = sortCssText(trimmedInput, options);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown CSS parsing error.';
			vscode.window.showErrorMessage(`banana sort: CSS validation failed. ${message}`);
			return;
		}

		const beforeCharacterCounts = countCharacters(trimmedInput);
		const afterCharacterCounts = countCharacters(sortedCss);
		const removedCharacterCounts = removedCharacters(beforeCharacterCounts, afterCharacterCounts);
		await editor.edit((editBuilder) => {
			editBuilder.replace(targetRange, sortedCss);
		});

		vscode.window.showInformationMessage(
			`banana sort (CSS) chars removed: ${formatRemovedCharacters(removedCharacterCounts)}`
		);
	});

	context.subscriptions.push(disposable);
}

/**
 * @returns {Promise<{
 * selectorListStyle: 'one-line'|'one-per-line'|'as-is',
 * selectorListStyleEmbedded: 'one-line'|'one-per-line'|'as-is',
 * ruleSortOrder: string[],
 * padCombinators: boolean,
 * padAttributes: boolean,
 * selectorSpecificity: boolean,
 * }>} 
 */
async function loadCssOptions() {
	if (!vscode) {
		return {
			selectorListStyle: 'as-is',
			selectorListStyleEmbedded: 'as-is',
			ruleSortOrder: [...DEFAULT_RULE_SORT_ORDER],
			padCombinators: false,
			padAttributes: false,
			selectorSpecificity: true
		};
	}

	const config = vscode.workspace.getConfiguration('banana-sort');
	const cssConfig = config.get('css') || {};

	const selectorListStyle = SELECTOR_LAYOUT_VALUES.has(cssConfig.selectorListStyle)
		? cssConfig.selectorListStyle
		: 'as-is';
	const selectorListStyleEmbedded = SELECTOR_LAYOUT_VALUES.has(cssConfig.selectorListStyleEmbedded)
		? cssConfig.selectorListStyleEmbedded
		: 'as-is';

	let ruleSortOrder = Array.isArray(cssConfig.ruleSortOrder) ? cssConfig.ruleSortOrder : DEFAULT_RULE_SORT_ORDER;
	if (!isValidRuleSortOrder(ruleSortOrder)) {
		vscode.window.showErrorMessage('banana sort: invalid `banana-sort.css.ruleSortOrder`; resetting to default.');
		ruleSortOrder = [...DEFAULT_RULE_SORT_ORDER];
		try {
			await config.update('css.ruleSortOrder', [...DEFAULT_RULE_SORT_ORDER], vscode.ConfigurationTarget.Global);
		} catch {
			// Ignore update failures.
		}
	}

	return {
		selectorListStyle,
		selectorListStyleEmbedded,
		ruleSortOrder,
		padCombinators: Boolean(cssConfig.padCombinators),
		padAttributes: Boolean(cssConfig.padAttributes),
		selectorSpecificity: cssConfig.selectorSpecificity !== false
	};
}

/**
 * @param {unknown} value
 */
function isValidRuleSortOrder(value) {
	if (!Array.isArray(value) || value.length !== 4) {
		return false;
	}
	const required = new Set(DEFAULT_RULE_SORT_ORDER);
	for (const item of value) {
		if (!required.has(item)) {
			return false;
		}
		required.delete(item);
	}
	return required.size === 0;
}

/**
 * @param {string} text
 */
function countCharacters(text) {
	/** @type {Record<string, number>} */
	const counts = {};
	for (const char of text) {
		counts[char] = (counts[char] ?? 0) + 1;
	}
	return counts;
}

/**
 * @param {Record<string, number>} before
 * @param {Record<string, number>} after
 */
function removedCharacters(before, after) {
	/** @type {Record<string, number>} */
	const removed = {};
	for (const [char, count] of Object.entries(before)) {
		if (/\s/.test(char)) {
			continue;
		}
		const diff = count - (after[char] ?? 0);
		if (diff > 0) {
			removed[char] = diff;
		}
	}
	return removed;
}

/**
 * @param {Record<string, number>} removed
 */
function formatRemovedCharacters(removed) {
	const entries = Object.entries(removed).sort((a, b) => a[0].localeCompare(b[0]));
	if (entries.length === 0) {
		return 'none';
	}
	return entries.map(([char, count]) => `${JSON.stringify(char)}:${count}`).join(', ');
}

/**
 * @param {string} cssText
 * @param {ReturnType<typeof loadCssOptions> extends Promise<infer T> ? T : never} options
 */
function sortCssText(cssText, options) {
	validateBalancedCss(cssText);
	const rawRules = splitTopLevelRules(cssText);
	if (rawRules.length === 0) {
		throw new Error('No CSS rules found.');
	}

	/** @type {Array<ReturnType<typeof parseStandardRule> | ReturnType<typeof parseAtRule>>} */
	const parsedItems = rawRules.map((rawRule) => {
		if (rawRule.trim().startsWith('@')) {
			return parseAtRule(rawRule, options);
		}
		return parseStandardRule(rawRule, options);
	});

	const categoryIndex = new Map(options.ruleSortOrder.map((k, i) => [k, i]));
	parsedItems.sort((a, b) => {
		const d = (categoryIndex.get(ruleCategory(a)) ?? 0) - (categoryIndex.get(ruleCategory(b)) ?? 0);
		if (d !== 0) {
			return d;
		}
		if (a.kind === 'standard' && b.kind === 'standard') {
			return compareSelectorsForSort(a.selectors[0].sortKey, b.selectors[0].sortKey, options);
		}
		if (a.kind === 'at' && b.kind === 'at') {
			return a.sortKey.localeCompare(b.sortKey, undefined, { sensitivity: 'base' });
		}
		return 0;
	});

	return parsedItems
		.map((item) => item.kind === 'standard' ? stringifyStandardRule(item, options) : stringifyAtRule(item, options))
		.join('\n\n')
		.trim();
}

/**
 * @param {ReturnType<typeof parseStandardRule> | ReturnType<typeof parseAtRule>} rule
 */
function ruleCategory(rule) {
	if (rule.kind === 'at') {
		return '@at-rule';
	}
	const first = rule.selectors[0].sortKey.trim().toLowerCase();
	if (first.startsWith(':root')) {
		return ':root';
	}
	if (first.startsWith('::')) {
		return '::pseudo';
	}
	return 'selector';
}

/**
 * @param {string} ruleText
 * @param {ReturnType<typeof loadCssOptions> extends Promise<infer T> ? T : never} options
 */
function parseAtRule(ruleText, options) {
	const trimmed = ruleText.trim();
	const openBraceIndex = findFirstTopLevelChar(trimmed, '{');
	if (openBraceIndex === -1) {
		return {
			kind: 'at',
			ruleIndent: '',
			oneLineRule: !/\r?\n/.test(trimmed),
			header: trimmed.replace(/;$/, '').trim(),
			body: '',
			hasBlock: false,
			sortKey: trimmed.toLowerCase()
		};
	}
	if (!trimmed.endsWith('}')) {
		throw new Error(`Invalid at-rule: "${trimmed.slice(0, 40)}..."`);
	}

	const header = trimmed.slice(0, openBraceIndex).trim();
	const body = trimmed.slice(openBraceIndex + 1, trimmed.lastIndexOf('}'));
	const hasNestedRules = hasTopLevelBlock(body);
	return {
		kind: 'at',
		ruleIndent: '',
		oneLineRule: /^[^\n\r]*\{[^\n\r]*\}[ \t]*$/.test(trimmed),
		header,
		body: hasNestedRules ? sortCssText(body.trim(), options) : body.trim(),
		hasBlock: true,
		sortKey: header.toLowerCase()
	};
}

/**
 * @param {ReturnType<typeof parseAtRule>} rule
 * @param {ReturnType<typeof loadCssOptions> extends Promise<infer T> ? T : never} _options
 */
function stringifyAtRule(rule, _options) {
	if (!rule.hasBlock) {
		return `${rule.header};`;
	}
	if (!rule.body.trim()) {
		return `${rule.header} {}`;
	}
	if (rule.oneLineRule && !/\r?\n/.test(rule.body)) {
		return `${rule.header} { ${rule.body} }`;
	}
	return `${rule.header} {\n${indentBlock(rule.body, '\t')}\n}`;
}

/**
 * @param {string} value
 */
function hasTopLevelBlock(value) {
	const segments = splitBodyTopLevelItems(value);
	return segments.some((segment) => {
		const chunk = stripLeadingComments(segment).trim();
		return findFirstTopLevelChar(chunk, '{') !== -1 && chunk.endsWith('}');
	});
}

/**
 * @param {string} cssText
 */
function validateBalancedCss(cssText) {
	let depth = 0;
	let inString = false;
	let stringQuote = '';
	let inComment = false;
	for (let i = 0; i < cssText.length; i += 1) {
		const char = cssText[i];
		const next = cssText[i + 1];

		if (inComment) {
			if (char === '*' && next === '/') {
				inComment = false;
				i += 1;
			}
			continue;
		}
		if (inString) {
			if (char === '\\') {
				i += 1;
				continue;
			}
			if (char === stringQuote) {
				inString = false;
			}
			continue;
		}

		if (char === '/' && next === '*') {
			inComment = true;
			i += 1;
			continue;
		}
		if (char === '"' || char === "'") {
			inString = true;
			stringQuote = char;
			continue;
		}
		if (char === '{') {
			depth += 1;
			continue;
		}
		if (char === '}') {
			depth -= 1;
			if (depth < 0) {
				throw new Error('Unexpected closing brace.');
			}
		}
	}

	if (inComment) {
		throw new Error('Unclosed CSS comment.');
	}
	if (inString) {
		throw new Error('Unclosed CSS string.');
	}
	if (depth !== 0) {
		throw new Error('Unbalanced CSS braces.');
	}
}

/**
 * @param {string} cssText
 * @returns {string[]}
 */
function splitTopLevelRules(cssText) {
	/** @type {string[]} */
	const rules = [];
	let start = 0;
	let depth = 0;
	let inString = false;
	let stringQuote = '';
	let inComment = false;
	for (let i = 0; i < cssText.length; i += 1) {
		const char = cssText[i];
		const next = cssText[i + 1];

		if (inComment) {
			if (char === '*' && next === '/') {
				inComment = false;
				i += 1;
			}
			continue;
		}
		if (inString) {
			if (char === '\\') {
				i += 1;
				continue;
			}
			if (char === stringQuote) {
				inString = false;
			}
			continue;
		}

		if (char === '/' && next === '*') {
			inComment = true;
			i += 1;
			continue;
		}
		if (char === '"' || char === "'") {
			inString = true;
			stringQuote = char;
			continue;
		}
		if (char === '{') {
			depth += 1;
			continue;
		}
		if (char === '}') {
			depth -= 1;
			if (depth === 0) {
				const segment = cssText.slice(start, i + 1).trim();
				if (segment) {
					rules.push(segment);
				}
				start = i + 1;
			}
			continue;
		}
		if (char === ';' && depth === 0) {
			const segment = cssText.slice(start, i + 1).trim();
			if (segment) {
				rules.push(segment);
			}
			start = i + 1;
		}
	}

	const trailing = cssText.slice(start).trim();
	if (trailing) {
		throw new Error('Unexpected trailing text outside of CSS rules.');
	}
	return rules;
}

/**
 * @param {string} ruleText
 * @param {ReturnType<typeof loadCssOptions> extends Promise<infer T> ? T : never} options
 */
function parseStandardRule(ruleText, options) {
	const openBraceIndex = findFirstTopLevelChar(ruleText, '{');
	if (openBraceIndex <= 0 || !ruleText.trim().endsWith('}')) {
		throw new Error(`Invalid CSS rule: "${ruleText.slice(0, 40)}..."`);
	}

	const selectorPart = ruleText.slice(0, openBraceIndex);
	const bodyPart = ruleText.slice(openBraceIndex + 1, ruleText.lastIndexOf('}'));
	const selectorIndentMatch = selectorPart.match(/^[ \t]*/);
	const ruleIndent = selectorIndentMatch ? selectorIndentMatch[0] : '';
	const oneLineRule = /^[^\n\r]*\{[^\n\r]*\}[ \t]*$/.test(ruleText.trim());

	const selectorItems = parseSelectorItems(selectorPart, options);
	if (selectorItems.length === 0) {
		throw new Error('No selectors found.');
	}

	const bodyItems = parseBodyItems(bodyPart, options);
	if (bodyItems.length === 0) {
		throw new Error(`Rule "${selectorItems[0].sortKey}" has no valid body items.`);
	}

	return {
		kind: 'standard',
		ruleIndent,
		oneLineRule,
		selectorPartHasNewline: /\r?\n/.test(selectorPart),
		selectors: selectorItems,
		bodyItems
	};
}

/**
 * @param {string} selectorPart
 * @param {ReturnType<typeof loadCssOptions> extends Promise<infer T> ? T : never} options
 */
function parseSelectorItems(selectorPart, options) {
	const trimmed = selectorPart.trim();
	const segments = splitTopLevel(trimmed, ',');
	/** @type {{text: string, sortKey: string, leadingComments: string[], trailingComment: string}} */
	const items = [];
	for (const segment of segments) {
		const parsed = splitLeadingComments(segment);
		let leadingComments = [...parsed.comments];
		let body = parsed.remainder.trim();

		if (leadingComments.length > 0 && items.length > 0 && shouldAttachLeadingCommentToPrevious(segment)) {
			const attached = leadingComments.shift();
			if (attached) {
				const previous = items[items.length - 1];
				previous.trailingComment = previous.trailingComment
					? `${previous.trailingComment} ${attached}`
					: attached;
			}
		}

		if (!body) {
			continue;
		}
		const formatted = formatSelector(body, options);
		if (!formatted.trim()) {
			continue;
		}
		items.push({
			text: formatted,
			sortKey: sortableSelector(formatted, options),
			leadingComments,
			trailingComment: ''
		});
	}

	items.sort((a, b) => compareSelectorsForSort(a.sortKey, b.sortKey, options));
	return items;
}

/**
 * @param {string} bodyPart
 * @param {ReturnType<typeof loadCssOptions> extends Promise<infer T> ? T : never} options
 */
function parseBodyItems(bodyPart, options) {
	const segments = splitBodyTopLevelItems(bodyPart);
	/** @type {string[]} */
	let pendingComments = [];
	/** @type {Array<
	 * {kind: 'declaration', property: string, value: string, comments: string[]} |
	 * {kind: 'standard', rule: ReturnType<typeof parseStandardRule>, comments: string[]} |
	 * {kind: 'at', rule: ReturnType<typeof parseAtRule>, comments: string[]}
	 * >}
	 */
	const items = [];

	for (const segment of segments) {
		const parsed = splitLeadingComments(segment);
		const chunk = parsed.remainder.trim();
		const comments = [...pendingComments, ...parsed.comments];
		if (!chunk) {
			continue;
		}
		if (isCommentOnly(chunk)) {
			pendingComments = [...comments, chunk];
			continue;
		}
		const openBraceIndex = findFirstTopLevelChar(chunk, '{');
		if (openBraceIndex !== -1 && chunk.endsWith('}')) {
			if (chunk.startsWith('@')) {
				items.push({ kind: 'at', rule: parseAtRule(chunk, options), comments });
			} else {
				items.push({ kind: 'standard', rule: parseStandardRule(chunk, options), comments });
			}
			pendingComments = [];
			continue;
		}
		const declarationSource = chunk.replace(/;\s*$/, '').trim();
		const declaration = parseDeclaration(declarationSource, options);
		items.push({
			kind: 'declaration',
			property: declaration.property,
			value: declaration.value,
			comments
		});
		pendingComments = [];
	}

	/** @type {Array<{kind: 'declaration', property: string, value: string, comments: string[]}>} */
	const declarations = items.filter((item) => item.kind === 'declaration');
	/** @type {Array<{kind: 'standard', rule: ReturnType<typeof parseStandardRule>, comments: string[]} | {kind: 'at', rule: ReturnType<typeof parseAtRule>, comments: string[]}>} */
	const nested = items.filter((item) => item.kind !== 'declaration');

	declarations.sort((a, b) => {
		const aNested = a.property.trim().startsWith('&') ? 1 : 0;
		const bNested = b.property.trim().startsWith('&') ? 1 : 0;
		if (aNested !== bNested) {
			return aNested - bNested;
		}
		return a.property.toLowerCase().localeCompare(b.property.toLowerCase());
	});

	nested.sort((a, b) => {
		const categoryA = a.kind === 'at' ? '@at-rule' : ruleCategory(a.rule);
		const categoryB = b.kind === 'at' ? '@at-rule' : ruleCategory(b.rule);
		const categoryIndex = new Map(options.ruleSortOrder.map((k, i) => [k, i]));
		const d = (categoryIndex.get(categoryA) ?? 0) - (categoryIndex.get(categoryB) ?? 0);
		if (d !== 0) {
			return d;
		}
		if (a.kind === 'standard' && b.kind === 'standard') {
			return compareSelectorsForSort(a.rule.selectors[0].sortKey, b.rule.selectors[0].sortKey, options);
		}
		if (a.kind === 'at' && b.kind === 'at') {
			return a.rule.sortKey.localeCompare(b.rule.sortKey, undefined, { sensitivity: 'base' });
		}
		return 0;
	});

	return [...declarations, ...nested];
}

/**
 * @param {ReturnType<typeof parseStandardRule>} rule
 * @param {ReturnType<typeof loadCssOptions> extends Promise<infer T> ? T : never} options
 */
function stringifyStandardRule(rule, options) {
	const selectorLayout = resolveSelectorLayout(rule, options.selectorListStyle);
	const isDeclarationOnly = rule.bodyItems.every((item) => item.kind === 'declaration');
	const hasBodyComments = rule.bodyItems.some((item) => item.comments.length > 0);

	if (rule.oneLineRule && isDeclarationOnly && !hasBodyComments) {
		const selectorLine = rule.selectors
			.map((s) => s.trailingComment ? `${s.text} ${s.trailingComment}` : s.text)
			.join(', ');
		const bodyLine = rule.bodyItems
			.map((item) => {
				if (item.kind === 'declaration') {
					return `${item.property}: ${item.value};`;
				}
				if (item.kind === 'standard') {
					return stringifyStandardRule(item.rule, options);
				}
				return stringifyAtRule(item.rule, options);
			})
			.join(' ');
		return `${rule.ruleIndent}${selectorLine} { ${bodyLine} }`;
	}
	const hasLeadingSelectorComments = rule.selectors.some((s) => s.leadingComments.length > 0);
	let selectorBlock;
	if (selectorLayout === 'one-line' && !hasLeadingSelectorComments) {
		selectorBlock = `${rule.ruleIndent}${rule.selectors.map((s) => s.trailingComment ? `${s.text} ${s.trailingComment}` : s.text).join(', ')}`;
	} else {
		/** @type {string[]} */
		const selectorLines = [];
		rule.selectors.forEach((selector, index) => {
			for (const comment of selector.leadingComments) {
				selectorLines.push(`${rule.ruleIndent}${comment}`);
			}
			const withTrailing = selector.trailingComment
				? `${selector.text} ${selector.trailingComment}`
				: selector.text;
			const comma = index < rule.selectors.length - 1 ? ',' : '';
			selectorLines.push(`${rule.ruleIndent}${withTrailing}${comma}`);
		});
		selectorBlock = selectorLines.join('\n');
	}

	const itemIndent = `${rule.ruleIndent}\t`;
	const declarationLines = [];
	for (const item of rule.bodyItems) {
		for (const comment of item.comments) {
			declarationLines.push(`${itemIndent}${comment.replace(/^\s+/, '')}`);
		}
		if (item.kind === 'declaration') {
			declarationLines.push(`${itemIndent}${item.property}: ${item.value};`);
			continue;
		}
		const nestedBlock = item.kind === 'standard'
			? stringifyStandardRule(item.rule, options)
			: stringifyAtRule(item.rule, options);
		declarationLines.push(indentBlock(nestedBlock, itemIndent));
	}

	return `${selectorBlock} {\n${declarationLines.join('\n')}\n${rule.ruleIndent}}`;
}

/**
 * @param {ReturnType<typeof parseStandardRule>} rule
 * @param {'one-line'|'one-per-line'|'as-is'} layout
 */
function resolveSelectorLayout(rule, layout) {
	if (layout !== 'as-is') {
		return layout;
	}
	return rule.selectorPartHasNewline ? 'one-per-line' : 'one-line';
}

/**
 * @param {string} selector
 * @param {ReturnType<typeof loadCssOptions> extends Promise<infer T> ? T : never} options
 */
function formatSelector(selector, options) {
	let out = selector;
	out = sortEmbeddedSelectorLists(out, options);
	out = normalizeSpacingForSort(out);
	if (options.padCombinators) {
		out = padCombinators(out);
	}
	if (options.padAttributes) {
		out = padAttributes(out);
	} else {
		out = compactAttributes(out);
	}
	return out.trim();
}

/**
 * @param {string} selector
 */
function normalizeSpacingForSort(selector) {
	let out = selector;
	out = out.replace(/\s*\|\|\s*/g, '||');
	out = out.replace(/\s*([>+~&])\s*/g, '$1');
	out = out.replace(/\s+/g, ' ');
	return out.trim();
}

/**
 * @param {string} selector
 */
function padCombinators(selector) {
	let out = selector;
	out = out.replace(/\s*\|\|\s*/g, ' || ');
	out = out.replace(/\s*([>+~&])\s*/g, ' $1 ');
	out = out.replace(/\s{2,}/g, ' ');
	return out.trim();
}

/**
 * @param {string} selector
 */
function compactAttributes(selector) {
	return selector.replace(/\[([^\]]+)\]/g, (_, inside) => `[${inside.replace(/\s*=\s*/g, '=').replace(/\s+/g, ' ').trim()}]`);
}

/**
 * @param {string} selector
 */
function padAttributes(selector) {
	return selector.replace(/\[([^\]]+)\]/g, (_, inside) => `[ ${inside.replace(/\s*=\s*/g, ' = ').replace(/\s+/g, ' ').trim()} ]`);
}

/**
 * @param {string} selector
 * @param {ReturnType<typeof loadCssOptions> extends Promise<infer T> ? T : never} options
 */
function sortEmbeddedSelectorLists(selector, options) {
	const pseudoWithSelectorArgs = /:(?:not|is|where|has|matches|nth-child|nth-last-child)\(/i;
	if (!pseudoWithSelectorArgs.test(selector)) {
		return selector;
	}

	let output = '';
	for (let i = 0; i < selector.length; i += 1) {
		const char = selector[i];
		if (char !== ':') {
			output += char;
			continue;
		}

		const rest = selector.slice(i);
		const match = rest.match(/^:(not|is|where|has|matches|nth-child|nth-last-child)\(/i);
		if (!match) {
			output += char;
			continue;
		}

		const prefix = match[0];
		const start = i + prefix.length - 1;
		const end = findMatchingParen(selector, start);
		if (end === -1) {
			output += char;
			continue;
		}

		const content = selector.slice(start + 1, end);
		const parts = splitTopLevel(content, ',').map((p) => formatSelector(p.trim(), options)).filter(Boolean);
		parts.sort((a, b) => compareSelectorsForSort(sortableSelector(a, options), sortableSelector(b, options), options));

		let embeddedLayout = options.selectorListStyleEmbedded;
		if (embeddedLayout === 'as-is') {
			embeddedLayout = /\r?\n/.test(content) ? 'one-per-line' : 'one-line';
		}
		const joined = embeddedLayout === 'one-per-line'
			? `\n\t${parts.join(',\n\t')}\n`
			: parts.join(', ');

		output += `${prefix}${joined})`;
		i = end;
	}
	return output;
}

/**
 * @param {string} input
 * @param {number} openParenIndex
 */
function findMatchingParen(input, openParenIndex) {
	let depth = 0;
	let inString = false;
	let quote = '';
	for (let i = openParenIndex; i < input.length; i += 1) {
		const c = input[i];
		if (inString) {
			if (c === '\\') {
				i += 1;
				continue;
			}
			if (c === quote) {
				inString = false;
			}
			continue;
		}
		if (c === '"' || c === "'") {
			inString = true;
			quote = c;
			continue;
		}
		if (c === '(') {
			depth += 1;
		} else if (c === ')') {
			depth -= 1;
			if (depth === 0) {
				return i;
			}
		}
	}
	return -1;
}

/**
 * @param {string} selector
 * @param {ReturnType<typeof loadCssOptions> extends Promise<infer T> ? T : never} options
 */
function sortableSelector(selector, options) {
	let key = selector;
	key = stripComments(key);
	key = normalizeSpacingForSort(key);
	if (options.selectorSpecificity) {
		key = key.replace(/[#.]/g, '');
	}
	return key.trim().toLowerCase();
}

/**
 * @param {string} a
 * @param {string} b
 * @param {ReturnType<typeof loadCssOptions> extends Promise<infer T> ? T : never} options
 */
function compareSelectorsForSort(a, b, options) {
	if (a === b) {
		return 0;
	}

	const tokenA = leadingCategoryToken(a);
	const tokenB = leadingCategoryToken(b);
	const rankDiff = selectorRank(tokenA) - selectorRank(tokenB);
	if (rankDiff !== 0) {
		return rankDiff;
	}

	const lexical = a.localeCompare(b, undefined, { sensitivity: 'base' });
	if (lexical !== 0) {
		return lexical;
	}

	if (options.selectorSpecificity) {
		if (/^#/.test(a) && /^\./.test(b)) {
			return -1;
		}
		if (/^\./.test(a) && /^#/.test(b)) {
			return 1;
		}
	}
	return a.localeCompare(b);
}

/**
 * @param {string} selector
 */
function leadingCategoryToken(selector) {
	const trimmed = selector.trim();
	if (!trimmed) {
		return '';
	}
	if (trimmed.startsWith('*')) return '*';
	if (trimmed.startsWith('#')) return '#';
	if (trimmed.startsWith('.')) return '.';
	if (trimmed.startsWith('[')) return '[]';
	if (trimmed.startsWith('::')) return '::';
	if (trimmed.startsWith(':')) return ':';
	if (trimmed.startsWith('||')) return '||';
	if (trimmed.startsWith('+')) return '+';
	if (trimmed.startsWith('~')) return '~';
	if (trimmed.startsWith('>')) return '>';
	if (/^[a-z]/i.test(trimmed)) return 'a-z';
	if (/^\s/.test(selector)) return ' ';
	return 'a-z';
}

/**
 * @param {string} token
 */
function selectorRank(token) {
	switch (token) {
		case '*': return 0;
		case '#': return 1;
		case '.': return 2;
		case 'a-z': return 3;
		case '[]': return 4;
		case ':': return 5;
		case '::': return 6;
		case '||': return 7;
		case '+': return 8;
		case '~': return 9;
		case '>': return 10;
		case ' ': return 11;
		default: return 99;
	}
}

/**
 * @param {string} declaration
 * @param {ReturnType<typeof loadCssOptions> extends Promise<infer T> ? T : never} _options
 */
function parseDeclaration(declaration, _options) {
	const colonIndex = findFirstTopLevelChar(declaration, ':');
	if (colonIndex <= 0) {
		throw new Error(`Invalid declaration "${declaration}".`);
	}

	const property = declaration.slice(0, colonIndex).trim();
	const value = declaration.slice(colonIndex + 1).trim();
	if (!property || !value) {
		throw new Error(`Invalid declaration "${declaration}".`);
	}
	return { property, value };
}

/**
 * @param {string} input
 * @returns {string[]}
 */
function splitBodyTopLevelItems(input) {
	/** @type {string[]} */
	const result = [];
	let start = 0;
	let depth = 0;
	let inString = false;
	let stringQuote = '';
	let inComment = false;

	for (let i = 0; i < input.length; i += 1) {
		const char = input[i];
		const next = input[i + 1];

		if (inComment) {
			if (char === '*' && next === '/') {
				inComment = false;
				i += 1;
			}
			continue;
		}
		if (inString) {
			if (char === '\\') {
				i += 1;
				continue;
			}
			if (char === stringQuote) {
				inString = false;
			}
			continue;
		}
		if (char === '/' && next === '*') {
			inComment = true;
			i += 1;
			continue;
		}
		if (char === '"' || char === "'") {
			inString = true;
			stringQuote = char;
			continue;
		}

		if (char === '{') {
			depth += 1;
			continue;
		}
		if (char === '}') {
			depth -= 1;
			if (depth === 0) {
				result.push(input.slice(start, i + 1));
				start = i + 1;
			}
			continue;
		}
		if (char === ';' && depth === 0) {
			result.push(input.slice(start, i + 1));
			start = i + 1;
		}
	}

	const trailing = input.slice(start);
	if (trailing.trim()) {
		result.push(trailing);
	}
	return result;
}

/**
 * @param {string} value
 * @param {string} prefix
 */
function indentBlock(value, prefix) {
	return value
		.split(/\r?\n/)
		.map((line) => `${prefix}${line}`)
		.join('\n');
}

/**
 * @param {string} input
 * @param {string} delimiter
 * @returns {string[]}
 */
function splitTopLevel(input, delimiter) {
	/** @type {string[]} */
	const result = [];
	let start = 0;
	let curly = 0;
	let round = 0;
	let square = 0;
	let inString = false;
	let stringQuote = '';
	let inComment = false;
	for (let i = 0; i < input.length; i += 1) {
		const char = input[i];
		const next = input[i + 1];

		if (inComment) {
			if (char === '*' && next === '/') {
				inComment = false;
				i += 1;
			}
			continue;
		}
		if (inString) {
			if (char === '\\') {
				i += 1;
				continue;
			}
			if (char === stringQuote) {
				inString = false;
			}
			continue;
		}
		if (char === '/' && next === '*') {
			inComment = true;
			i += 1;
			continue;
		}
		if (char === '"' || char === "'") {
			inString = true;
			stringQuote = char;
			continue;
		}

		if (char === '{') {
			curly += 1;
			continue;
		}
		if (char === '}') {
			curly -= 1;
			continue;
		}
		if (char === '(') {
			round += 1;
			continue;
		}
		if (char === ')') {
			round -= 1;
			continue;
		}
		if (char === '[') {
			square += 1;
			continue;
		}
		if (char === ']') {
			square -= 1;
			continue;
		}

		if (char === delimiter && curly === 0 && round === 0 && square === 0) {
			result.push(input.slice(start, i));
			start = i + 1;
		}
	}
	result.push(input.slice(start));
	return result;
}

/**
 * @param {string} input
 * @param {string} target
 */
function findFirstTopLevelChar(input, target) {
	let curly = 0;
	let round = 0;
	let square = 0;
	let inString = false;
	let stringQuote = '';
	let inComment = false;
	for (let i = 0; i < input.length; i += 1) {
		const char = input[i];
		const next = input[i + 1];

		if (inComment) {
			if (char === '*' && next === '/') {
				inComment = false;
				i += 1;
			}
			continue;
		}
		if (inString) {
			if (char === '\\') {
				i += 1;
				continue;
			}
			if (char === stringQuote) {
				inString = false;
			}
			continue;
		}
		if (char === '/' && next === '*') {
			inComment = true;
			i += 1;
			continue;
		}
		if (char === '"' || char === "'") {
			inString = true;
			stringQuote = char;
			continue;
		}

		if (char === target && curly === 0 && round === 0 && square === 0) {
			return i;
		}

		if (char === '{') {
			curly += 1;
		} else if (char === '}') {
			curly -= 1;
		} else if (char === '(') {
			round += 1;
		} else if (char === ')') {
			round -= 1;
		} else if (char === '[') {
			square += 1;
		} else if (char === ']') {
			square -= 1;
		}
	}
	return -1;
}

/**
 * @param {string} value
 */
function stripComments(value) {
	return value.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * @param {string} value
 */
function splitLeadingComments(value) {
	const startsWithNewline = /^\s*\r?\n/.test(value);
	let rest = value;
	/** @type {string[]} */
	const comments = [];

	while (true) {
		const match = rest.match(/^\s*(\/\*[\s\S]*?\*\/)\s*/);
		if (!match) {
			break;
		}
		comments.push(match[1]);
		rest = rest.slice(match[0].length);
	}

	return { comments, remainder: rest, startsWithNewline };
}

/**
 * @param {string} segment
 */
function shouldAttachLeadingCommentToPrevious(segment) {
	const match = segment.match(/^[ \t]*(\/\*[\s\S]*?\*\/)/);
	if (!match) {
		return false;
	}
	return !/^\s*\r?\n/.test(segment);
}

/**
 * @param {string} value
 */
function isCommentOnly(value) {
	return stripComments(value).trim() === '';
}

/**
 * @param {string} value
 */
function stripLeadingComments(value) {
	return value.replace(/^\s*(\/\*[\s\S]*?\*\/\s*)+/, '').trim();
}

function deactivate() {}

module.exports = {
	activate,
	deactivate,
	// Export internals for tests.
	_test: {
		sortCssText,
		isValidRuleSortOrder,
		formatSelector,
		compareSelectorsForSort,
		sortableSelector,
		countCharacters,
		removedCharacters,
		formatRemovedCharacters
	}
};
