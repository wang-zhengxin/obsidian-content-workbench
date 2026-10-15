export class TFile {
  path: string;
  stat = { mtime: Date.now(), ctime: Date.now(), size: 0 };
  constructor(path: string) {
    this.path = path;
  }
  get basename() {
    return this.path.split("/").at(-1)!.replace(/\.md$/, "");
  }
  get extension() {
    return this.path.split(".").at(-1)!;
  }
}
export function normalizePath(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}
export class App {}
