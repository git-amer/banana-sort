const assert = require('assert');
const extension = require('../extension');

suite('banana sort CSS', () => {
	const options = {
		selectorListStyle: 'one-line',
		selectorListStyleEmbedded: 'one-line',
		ruleSortOrder: [':root', 'selector', '::pseudo', '@at-rule'],
		padCombinators: false,
		padAttributes: false,
		selectorSpecificity: true
	};

	test('sorts rules by category and selectors', () => {
		const input = [
			'.b { z-index: 2; color: red; }',
			':root { --x: 1; }',
			'::before { content: "x"; display: block; }',
			'@media (min-width: 100px) { .a { color: blue; } }',
			'.a { color: blue; z-index: 1; }'
		].join('\n');

		const out = extension._test.sortCssText(input, options);
		const blocks = out.split(/\n\n/);

		assert.ok(blocks[0].startsWith(':root'));
		assert.ok(blocks[1].startsWith('.a'));
		assert.ok(blocks[2].startsWith('.b'));
		assert.ok(blocks[3].startsWith('::before'));
		assert.ok(blocks[4].startsWith('@media'));
	});

	test('pads combinators and attributes when enabled', () => {
		const localOptions = {
			...options,
			padCombinators: true,
			padAttributes: true
		};

		const input = '.a+b[no="space"] { color:red; }';
		const out = extension._test.sortCssText(input, localOptions);

		assert.ok(out.startsWith('.a + b[ no = "space" ] {'));
	});

	test('keeps one-line rules one-line and sorts declarations', () => {
		const input = '.z, .a { z-index: 2; color: red; }';
		const out = extension._test.sortCssText(input, options);

		assert.strictEqual(out, '.a, .z { color: red; z-index: 2; }');
	});

	test('keeps selector comments with their selector item', () => {
		const input = '.aclass, /* inline */\n.another,\n/* standalone */\n.more { width: 100px; color: red; }';
		const out = extension._test.sortCssText(input, { ...options, selectorListStyle: 'as-is' });

		assert.ok(out.includes('.aclass /* inline */'));
		assert.ok(out.includes('/* standalone */'));
	});

	test('validates rule sort order shape', () => {
		assert.strictEqual(extension._test.isValidRuleSortOrder([':root', 'selector', '::pseudo', '@at-rule']), true);
		assert.strictEqual(extension._test.isValidRuleSortOrder([':root', 'selector', '@at-rule']), false);
		assert.strictEqual(extension._test.isValidRuleSortOrder([':root', 'selector', '::pseudo', 'oops']), false);
	});

	test('recursively sorts rules inside at-rules', () => {
		const input = '@media (min-width: 100px) { .b { z-index: 2; color: red; } .a { z-index: 1; color: blue; } }';
		const out = extension._test.sortCssText(input, options);

		const posA = out.indexOf('.a');
		const posB = out.indexOf('.b');
		assert.ok(posA >= 0 && posB >= 0 && posA < posB);
		assert.ok(out.includes('color: blue; z-index: 1;'));
		assert.ok(out.includes('color: red; z-index: 2;'));
	});

	test('places nested selectors at end of sorted body items', () => {
		const input = '.a { z-index: 2; &:hover { color: red; } color: blue; }';
		const out = extension._test.sortCssText(input, options);

		assert.strictEqual(out, '.a { color: blue; z-index: 2; &:hover { color: red; } }');
	});

	test('reports removed characters by exact character excluding whitespace', () => {
		const before = extension._test.countCharacters('a b,');
		const after = extension._test.countCharacters('a b');
		const removed = extension._test.removedCharacters(before, after);

		assert.deepStrictEqual(removed, { ',': 1 });
		assert.strictEqual(extension._test.formatRemovedCharacters(removed), '",":1');
		assert.strictEqual(extension._test.formatRemovedCharacters({}), 'none');
	});
});
