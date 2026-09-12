"""Build the study fragment from the user's reference skin and circle renderer.

Only selector scoping changes the imported CSS. Proposal layers live in
swarm-studies.html; the reference file is always read-only.
"""

from pathlib import Path
import hashlib
import json
import re

HERE = Path(__file__).resolve().parent
REFERENCE_ORIGIN = '/private/tmp/claude-501/-Users-jamesyong-Projects-project100-puppeteer/196684d5-f97d-4c4e-858c-03be7fb3e05a/scratchpad/swarm-proposals.html'
REFERENCE = HERE / 'reference-snapshot.html'
ROOT = '#swarm-design-lab'


def split_selectors(text):
    parts, start, depth, quote = [], 0, 0, None
    for index, char in enumerate(text):
        if quote:
            if char == quote and (index == 0 or text[index - 1] != '\\'):
                quote = None
        elif char in '\"\'':
            quote = char
        elif char in '([':
            depth += 1
        elif char in ')]':
            depth -= 1
        elif char == ',' and depth == 0:
            parts.append(text[start:index].strip())
            start = index + 1
    parts.append(text[start:].strip())
    return parts


def scoped_selector(selector):
    if ':root' in selector:
        return selector.replace(':root', ROOT)
    if selector in ('html', 'body', '#root'):
        return ROOT
    if selector == '.dark':
        return ROOT + '.dark'
    if selector == '*':
        return ROOT + ', ' + ROOT + ' *'
    return ROOT + ' ' + selector


def scoped_css(css):
    # The reference uses ordinary rules, media blocks, and keyframes. Scan
    # strings and balanced braces so colors/functions/declarations stay exact.
    css = re.sub(r'/\*[\s\S]*?\*/', '', css)
    out, start, index = [], 0, 0
    while index < len(css):
        opening = css.find('{', index)
        if opening < 0:
            break
        prelude = css[start:opening].strip()
        depth, quote, cursor = 1, None, opening + 1
        while cursor < len(css) and depth:
            char = css[cursor]
            if quote:
                if char == quote and css[cursor - 1] != '\\':
                    quote = None
            elif char in '\"\'':
                quote = char
            elif char == '{':
                depth += 1
            elif char == '}':
                depth -= 1
            cursor += 1
        if depth:
            raise ValueError('Unbalanced reference CSS')
        contents = css[opening + 1:cursor - 1]
        if prelude.startswith(('@media', '@supports', '@container', '@layer')):
            out.append(prelude + ' {\n' + scoped_css(contents) + '\n}')
        elif prelude.startswith('@'):
            out.append(prelude + ' {' + contents + '}')
        else:
            selectors = ',\n'.join(scoped_selector(s) for s in split_selectors(prelude))
            out.append(selectors + ' {' + contents + '}')
        start = index = cursor
    return '\n'.join(out)


def between(source, start, end):
    return source[source.index(start):source.index(end, source.index(start))]


source = REFERENCE.read_text()
styles = dict(re.findall(r'<style id="([^"]+)">([\s\S]*?)</style>', source))
skin_names = ('css-tokens', 'css-godview', 'css-swarm', 'css-bubble', 'css-page', 'css-proposals')
style_blocks = []
manifest = {'reference': REFERENCE_ORIGIN, 'snapshot': str(REFERENCE), 'css': {}}
for name in skin_names:
    value = styles[name]
    manifest['css'][name] = hashlib.sha256(value.encode()).hexdigest()
    style_blocks.append('<style data-reference="' + name + '">\n' + scoped_css(value) + '\n</style>')

marks = json.loads(re.search(r'var MARKS = (.*?);\n', source).group(1))
marks = {key: marks[key] for key in ('claudecode', 'codex')}
helpers = 'var MARKS = ' + json.dumps(marks, ensure_ascii=False) + ';\n'
helpers += between(source, '  var MARK_ID = ', '  /* ── the circle')
helpers += between(source, '  function noise(', '  var FOLDER = ')
helpers += between(source, '  var RATES = ', '  function r03()')
helpers += between(source, '  function ringHtml(', '  function r06()')
helpers += between(source, '  var RAISE = ', '  function r07()')
helpers += between(source, '  function innerLine(', '  var arcSeq = ')
helpers = helpers.replace(' title="', ' data-tooltip="')
manifest['bodyFunction'] = hashlib.sha256(between(source, '  function body(', '  function unit(').encode()).hexdigest()

template = (HERE / 'swarm-studies.html').read_text()
fragment = '\n'.join(style_blocks) + '\n' + template.replace('/*__REFERENCE_HELPERS__*/', helpers)
assert len(fragment.encode()) < 1_000_000
assert not re.search(r'<!doctype|<html[\s>]|<head>|<body[\s>]', fragment, re.I)
(HERE / 'swarm-design-lab.html').write_text(fragment)
(HERE / 'reference-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(f'Built {len(fragment.encode()):,} bytes from {len(skin_names)} reference stylesheets.')
