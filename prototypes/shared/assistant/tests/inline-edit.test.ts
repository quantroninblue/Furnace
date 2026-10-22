import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inlineEditPrompt, parseReplacement } from '../main/inline-edit';
import { lineHunks, unifiedDiff } from '../main/diff';

test("inline edit prompts carry nearby code; replacements come from the fenced block and keep the selection's shape", () => {
    const prompt = inlineEditPrompt({
        file: 'src/a.ts',
        language: 'typescript',
        before: 'line\n'.repeat(100) + 'function f() {\n',
        selection: '  return 1;\n',
        after: '}\n',
        instruction: 'return two',
    });
    assert.match(prompt, /Instruction: return two/);
    assert.match(prompt, /Selected code to replace:\n```\n  return 1;\n\n```/);
    assert.ok(prompt.split('line').length - 1 <= 61, 'only nearby lines are sent');
    assert.equal(parseReplacement('Here:\n```ts\nreturn 2;\n```\nDone.', '  return 1;\n'), '  return 2;\n');
    assert.equal(parseReplacement('```\nx\n```', 'y'), 'x');
    assert.equal(parseReplacement('plain text', 'z\n'), 'plain text\n');
    assert.throws(() => parseReplacement('```\n\n```', 'a'), /no replacement/);
});

test('line hunks list each changed range for keep/revert, and the unified diff is unchanged', () => {
    const before = 'a\nb\nc\nd\ne\n',
        after = 'a\nB\nc\nd\nx\ne\n';
    assert.deepEqual(lineHunks(before, after), [
        { beforeStart: 1, before: ['b'], afterStart: 1, after: ['B'] },
        { beforeStart: 4, before: [], afterStart: 4, after: ['x'] },
    ]);
    assert.match(unifiedDiff('f', before, after), /@@ -1,5 \+1,6 @@\n a\n-b\n\+B/);
});
