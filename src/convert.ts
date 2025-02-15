#!/usr/bin/env node
import { promises as fs } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import MarkdownIt from "markdown-it";
import { chromium, Page } from "playwright";
import { Command } from "commander";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type PDFOptions = {
  inputPath: string;
  outputPath: string;
  tempPath: string;
  margins?: {
    top: string;
    right: string;
    bottom: string;
    left: string;
  };
  format?: "A4" | "Letter";
};

const createHtmlDocument = (content: string): string => `
  <!DOCTYPE html>
  <html>
  <head>
    <script type="module">
      import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
      mermaid.initialize({ startOnLoad: true });
    </script>
    <style>
      body {
        margin: 3cm;
        font-family: "Times New Roman", Times, serif;
        font-size: 12pt;
        line-height: 1.5;
        max-width: 75ch;
        margin-left: auto;
        margin-right: auto;
      }
      
      .mermaid { 
        margin: 2em 0; 
      }

      h1, h2, h3, h4, h5, h6 {
        font-family: "Times New Roman", Times, serif;
        scroll-margin-top: 1em;
        line-height: 1.2;
      }

      h1 { font-size: 18pt; margin-top: 2em; }
      h2 { font-size: 16pt; margin-top: 1.5em; }
      h3 { font-size: 14pt; margin-top: 1.3em; }

      p {
        text-align: justify;
        margin: 1em 0;
      }

      a {
        color: #000000;
        text-decoration: none;
        border-bottom: 1px dotted #666;
      }

      h1 a, h2 a, h3 a, h4 a, h5 a, h6 a {
        border-bottom: none;
      }

      code a {
        border-bottom: none;
      }

      a:hover {
        border-bottom: 1px solid #000;
      }

      code {
        font-family: "Courier New", Courier, monospace;
        font-size: 11pt;
        background-color: #f5f5f5;
        padding: 0.2em 0.4em;
        border-radius: 3px;
      }

      pre code {
        display: block;
        padding: 1em;
        overflow-x: auto;
        line-height: 1.4;
      }

      blockquote {
        margin: 1.5em 0;
        padding-left: 1em;
        border-left: 3px solid #ccc;
        font-style: italic;
      }
    </style>
  </head>
  <body>
    ${content}
  </body>
  </html>
`;

const waitForMermaidRender = async (page: Page): Promise<void> => {
  await page.waitForFunction(() => {
    const diagrams = document.querySelectorAll(".mermaid");
    return Array.from(diagrams).every((d) => d.querySelector("svg"));
  });
};

const convertToPDF = async (options: PDFOptions): Promise<void> => {
  try {
    // Read and convert markdown
    const markdown = await fs.readFile(options.inputPath, "utf8");

    // Configure markdown-it with anchor handling
    const md = new MarkdownIt({
      html: true,
      linkify: true,
      typographer: true,
    });

    // Add heading anchor IDs
    md.use((md) => {
      const originalHeadingOpen =
        md.renderer.rules.heading_open ||
        ((tokens, idx, options, env, self) =>
          self.renderToken(tokens, idx, options));

      md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
        const title = tokens[idx + 1].content;
        const slug = title
          .toLowerCase()
          .replace(/[^\w\s-]/g, "")
          .replace(/\s+/g, "-")
          .replace(/-+/g, "-")
          .replace(/(^-|-$)/g, "");

        tokens[idx].attrPush(["id", slug]);
        return originalHeadingOpen(tokens, idx, options, env, self);
      };

      return md;
    });

    const html = md
      .render(markdown)
      // Handle Mermaid blocks
      .replace(
        /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
        '<div class="mermaid">$1</div>'
      );

    // Create and save full HTML
    const fullHtml = createHtmlDocument(html);
    await fs.writeFile(options.tempPath, fullHtml);

    // Launch browser and create PDF
    const browser = await chromium.launch();
    const page = await browser.newPage();

    const tempFilePath = resolve(process.cwd(), options.tempPath);
    await page.goto(`file://${tempFilePath}`);

    // Wait for Mermaid diagrams and ensure all content is loaded
    await waitForMermaidRender(page);
    await page.waitForLoadState("networkidle");

    // Get the full height of the content
    const height = await page.evaluate(() => {
      return document.documentElement.scrollHeight;
    });

    // Generate PDF with custom page size
    await page.pdf({
      path: options.outputPath,
      width: "8.5in",
      height: `${height}px`,
      margin: options.margins || {
        top: "1cm",
        right: "1cm",
        bottom: "1cm",
        left: "1cm",
      },
      printBackground: true,
      displayHeaderFooter: false,
      preferCSSPageSize: true,
      tagged: true,
    });

    await browser.close();

    // Cleanup
    await fs.unlink(options.tempPath);

    console.log(`PDF created successfully: ${options.outputPath}`);
  } catch (error) {
    console.error("Error during conversion:", error);
    throw error;
  }
};

const program = new Command();

program
  .name("md-to-pdf")
  .description("Convert Markdown with Mermaid diagrams to PDF")
  .version("1.0.0")
  .requiredOption("-i, --input <path>", "Input markdown file path")
  .option("-o, --output <path>", "Output PDF file path")
  .option("-t, --temp <path>", "Temporary HTML file path", "temp.html")
  .option("-f, --format <format>", "Page format (A4 or Letter)", "A4")
  .option("-m, --margin <margin>", "Page margins in cm", "1")
  .action(async (options) => {
    const outputPath =
      options.output || options.input.replace(/\.(md|markdown)$/, ".pdf");
    const margin = `${options.margin}cm`;

    try {
      await convertToPDF({
        inputPath: options.input,
        outputPath,
        tempPath: options.temp,
        format: options.format as "A4" | "Letter",
        margins: {
          top: margin,
          right: margin,
          bottom: margin,
          left: margin,
        },
      });
    } catch (error) {
      console.error("Conversion failed:", error);
      process.exit(1);
    }
  });

program.parse();
