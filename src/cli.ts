import path from "node:path";
import { copyFile } from "node:fs/promises";
import { compile } from "./build/compile";
import { ENGINES } from "../shared/types";
import { REPO } from "./repo";
import { applyTemplate, isEmptyWorkspace, listTemplates } from "./workspace/templates";

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case "pdf":
    await pdf(rest[0], rest[1]);
    break;
  case "doctor":
    doctor();
    break;
  case "new":
    await create(rest);
    break;
  default:
    console.log(`usage:
  bun dev [folder]                     open the app on a folder (default: the last one you had open)
  bun run new <folder> [--template t]  start a workspace from a template (resume, thesis, article, blank)
  bun run pdf <file.tex> [out.pdf]     compile once and write the PDF
  bun run doctor                       check your LaTeX install`);
    process.exit(command ? 1 : 0);
}

/** `new <folder> [--template name]`: make a folder (or fill an empty one) from a template. */
async function create(args: string[]) {
  const i = args.indexOf("--template");
  const name = i >= 0 ? args[i + 1] : "blank";
  const folder = args.find((a, j) => !a.startsWith("--") && j !== i + 1);
  const names = (await listTemplates()).map((t) => t.name);
  if (!folder || !name || !names.includes(name)) {
    console.error(`usage: bun run new <folder> [--template ${names.join("|")}]`);
    process.exit(1);
  }
  const dir = path.resolve(folder);
  if (!(await isEmptyWorkspace(dir).catch(() => true))) {
    console.error(`${dir} already has .tex files. Templates only fill an empty folder; open it with: bun dev ${folder}`);
    process.exit(1);
  }
  const open = await applyTemplate(dir, name);
  console.log(`✓ ${name} template in ${dir} (start with ${open})\n  open it: bun dev ${folder}`);
}

/** One-shot export: compile and copy the PDF next to where you ran the command. */
async function pdf(input?: string, output?: string) {
  if (!input) {
    console.error("usage: bun run pdf <file.tex> [out.pdf]");
    process.exit(1);
  }
  const texPath = path.resolve(input);
  const name = path.basename(texPath, ".tex");
  const result = await compile(texPath, path.join(REPO, "build", "_cli", name));

  for (const d of result.diagnostics.filter((d) => d.severity === "error")) {
    console.error(`  ${d.file ?? name}${d.line ? `:${d.line}` : ""}  ${d.message}`);
  }
  if (!result.ok) {
    console.error(`✗ ${input} failed to compile`);
    process.exit(1);
  }
  const dest = path.resolve(output ?? `${name}.pdf`);
  await copyFile(result.pdfPath, dest);
  console.log(`✓ ${dest}  (${result.pages} page${result.pages === 1 ? "" : "s"}, ${result.engine}, ${result.ms}ms)`);
}

function doctor() {
  const check = (bin: string) => {
    const found = Bun.which(bin);
    console.log(`  ${found ? "✓" : "·"} ${bin.padEnd(9)} ${found ?? "not found"}`);
    return found !== null;
  };

  console.log(`  ✓ bun       ${Bun.version}`);
  const engines = ENGINES.map(check).some(Boolean);
  const latexmk = check("latexmk");
  const git = check("git");

  if (!engines) {
    console.log(`\nNo LaTeX engine found. Install a TeX distribution:`);
    if (process.platform === "darwin") {
      console.log(`  brew install --cask basictex     # small (~100MB); or --cask mactex-no-gui for everything
  then open a new terminal so /Library/TeX/texbin is on your PATH`);
    } else if (process.platform === "win32") {
      console.log(`  https://miktex.org/download      # installs missing packages on demand`);
    } else {
      console.log(`  sudo apt install texlive-latex-extra texlive-fonts-extra latexmk   # Debian/Ubuntu
  sudo dnf install texlive-scheme-medium latexmk                      # Fedora`);
    }
  }
  if (!latexmk) {
    console.log(`\nOptional: latexmk handles bibliographies and reruns more reliably.
  ${process.platform === "darwin" ? "sudo tlmgr install latexmk" : "install the latexmk package for your OS"}`);
  }
  if (!git) {
    console.log(`\nOptional: git enables version history (snapshots, restore, comparisons).
  ${process.platform === "darwin" ? "xcode-select --install" : process.platform === "win32" ? "https://git-scm.com/download/win" : "install git with your package manager"}`);
  }
  if (engines) console.log(`\nReady. Run \`bun dev\` and put .tex files in latex/.`);
  process.exit(engines ? 0 : 1);
}
