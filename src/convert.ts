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
      body { margin: 2em; }
      .mermaid { margin: 1em 0; }
      /* Add styles for headings and links */
      h1, h2, h3, h4, h5, h6 {
        scroll-margin-top: 1em;
      }
      a {
        color: #0366d6;
        text-decoration: none;
      }
      a:hover {
        text-decoration: underline;
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

    // Generate PDF with enabled links
    await page.pdf({
      path: options.outputPath,
      format: options.format || "A4",
      margin: options.margins || {
        top: "1cm",
        right: "1cm",
        bottom: "1cm",
        left: "1cm",
      },
      printBackground: true,
      displayHeaderFooter: false,
      preferCSSPageSize: true,
      tagged: true, // Enable PDF tagging for better accessibility
      landscape: false,
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
