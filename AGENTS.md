# banana sort extension for VS Code

# Always

	- update changelog.md

### This extension will allow quick and simple sort of selection or file for many syntaxes that i use.

- css
	- sort selectors
	- sort properties

- json

- generic lines
	- natural numbers

### Advanced (future implementation)

- functions
	- python
	- javascript

- markdown?

### Miscellaneous

- we should include a line and character count of before and after.


## CSS handling
- mutiple selectors for a rule must have a setting in the options under a CSS section.
	- one line
		+ sorted of course, but all on one line. space after each comma.
	- one per line
		+ each selector on their own line.
	- as-is
		+ handle each rule separately. if its selectors are all on one line, use one line; otherwise one per line.
- embedded selectors have their own setting with the same options.
	+ a:not(.first, .second)
- if selectors and braces for a rule are all on one line, then we **always** keep that entire rule on one line, with spaces after commas, around `{`, and before `}`.
	+ .class1, class2 { background: white; color:black; }

- sort order for css rules is defined in the options by an arrays of strings. by default, `root` and `*` go first. `::pseudos` and `@rules` go at the end. in the settings.json, it should look something like this:
	```
	ruleSortOrder: [
		":root",
		"selector",
		"::pseudo",
		"@at-rule"
	]
	```
	- exactly those 4 items should always appear in that array. otherwise, throw a notification of the error and reset it to its default.

- we must handle spaces around *all* combinators first, as it will affect sorting.
	- add a setting in the options for *pad combinators*. if checked, put a space on each side of the combinators `> + ~ & ||`. default unchecked.
	- add another setting for *pad attributes*. default unchecked.
		+ `[ no = "spacing" ]` if checked, otherwise `[no="spacing"]`
	- remove all of this spacing before sorting. add padding after sorting.
	- *be careful to not remove spaces that represent the descendant combinator!*
	- it is **imperative** that we apply this before determining sort order.

- add another setting for `ignore selector specificity`. if checked (the default), ignore id and class operators at first when sorting. if there is a sorting tie, then prioritize `#` first and `.` second. if unchecked, then id comes before class, which comes before type.

- sort order for selectors.
	- `*` the universal selector comes first.
	- `#`
	- `.`
	- `a-Z` letters are sorted next without regard for case.
	- `[]`
	- `:`
	- `::`
	- `||`
	- `+`
	- `~`
	- `>`
	- ` `

- we must handle /* comments */
	- if a comment comes on a line after text, keep it on that line for the selector or item.
		```
		.aclassname, /* a comment */
		.anotherclass {
			background: white;
			color: red; /* black */
			width: 100px;
		}
		```
	- if a comment stands alone on a line (ignoring whitespace), then assume it applies to the selector or item immediately after it, but ignore it when determining sort order.
		```
		.aclassname,
		/* this travels with .anotherclass and stays above it, but is ignored when determining sorting priority. */
		.anotherclass,
		.moreclasses {...}
		```
- must handle nested rules with @ and nested selectors.
- nested selectors appears last within a ruleset, after all properties.
