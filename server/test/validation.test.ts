import test from 'node:test';
import assert from 'node:assert/strict';
import { detectMainClasses, validateFiles } from '../src/validation.ts';

test('accepts ordinary Java source files', () => {
  const files = validateFiles([{ path: 'Main.java', content: 'class Main {}' }]);
  assert.equal(files[0].path, 'Main.java');
});

test('rejects traversal and absolute paths', () => {
  assert.throws(() => validateFiles([{ path: '../Main.java', content: '' }]), /Unsafe source path/);
  assert.throws(() => validateFiles([{ path: '/tmp/Main.java', content: '' }]), /Unsafe source path/);
});

test('rejects duplicate paths and non-Java files', () => {
  assert.throws(() => validateFiles([{ path: 'Main.java', content: '' }, { path: 'Main.java', content: '' }]), /Duplicate/);
  assert.throws(() => validateFiles([{ path: 'Main.txt', content: '' }]), /Only .java/);
});

test('detects package-qualified main classes', () => {
  const found = detectMainClasses([{ path: 'src/school/Main.java', content: 'package school; public class Main { public static void main(String[] args) {} }' }]);
  assert.deepEqual(found, ['school.Main']);
});