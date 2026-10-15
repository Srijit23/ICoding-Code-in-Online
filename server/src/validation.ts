export type SubmittedFile = { path: string; content: string };

export const DEFAULT_SOURCE = [
  'import java.util.Scanner;',
  '',
  'public class Main {',
  '    public static void main(String[] args) {',
  '        Scanner sc = new Scanner(System.in);',
  '        System.out.print("Enter your name: ");',
  '        String name = sc.nextLine();',
  '        System.out.println("Hello, " + name + "!");',
  '    }',
  '}',
  ''
].join('\n');

export function validateFiles(input: unknown, maxFiles = 40, maxSourceBytes = 300000): SubmittedFile[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error('Add at least one Java source file.');
  if (input.length > maxFiles) throw new Error('A project can contain at most ' + maxFiles + ' source files.');
  let totalBytes = 0;
  const paths = new Set<string>();
  const result = input.map((item): SubmittedFile => {
    if (!item || typeof item !== 'object') throw new Error('Invalid source file entry.');
    const entry = item as Record<string, unknown>;
    if (typeof entry.path !== 'string' || typeof entry.content !== 'string') {
      throw new Error('Each source file needs a path and text content.');
    }
    const path = entry.path.replace(/\\/g, '/');
    if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path) ||
        path.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error('Unsafe source path: ' + entry.path);
    }
    if (!path.endsWith('.java')) throw new Error('Only .java files are accepted: ' + path);
    if (path.length > 240 || /[\0\r\n]/.test(path)) throw new Error('Invalid source file path.');
    if (paths.has(path)) throw new Error('Duplicate source path: ' + path);
    paths.add(path);
    totalBytes += Buffer.byteLength(entry.content, 'utf8');
    return { path, content: entry.content };
  });
  if (totalBytes > maxSourceBytes) {
    throw new Error('Source files exceed the ' + maxSourceBytes.toLocaleString() + ' byte limit.');
  }
  return result;
}

export function detectMainClasses(files: SubmittedFile[]): string[] {
  const candidates = new Set<string>();
  for (const file of files) {
    const packageName = file.content.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1];
    const names = [...file.content.matchAll(/\b(?:public\s+)?(?:final\s+|abstract\s+)?class\s+(\w+)/g)].map((match) => match[1]);
    if (!/\bstatic\s+void\s+main\s*\(\s*String\s*(?:\[\s*\]|\.\.\.)\s*\w*\s*\)/.test(file.content)) continue;
    const stem = file.path.split('/').pop()!.replace(/\.java$/, '');
    const className = names.includes(stem) ? stem : (names[0] || stem);
    candidates.add(packageName ? packageName + '.' + className : className);
  }
  return [...candidates].sort();
}