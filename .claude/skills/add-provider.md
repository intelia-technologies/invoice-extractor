# Add Provider Skill

Add a new invoice provider to the extension by creating a JSON definition.

## When to use

When the user wants to add support for downloading invoices from a new SaaS service.

## Workflow

1. **Navigate** to the provider's billing page using Chrome browser tools (`mcp__claude-in-chrome__*`)
2. **Capture DOM structure** — run JavaScript to inspect:
   - What CSS selector identifies the invoice table/list?
   - What date format is used?
   - Where are the download links?
   - Are invoices in a `<table>`, `<ul>`, or custom elements?
3. **Create JSON file** in `providers/<provider-id>.json` following the schema in CLAUDE.md
4. **Test** — reload extension and verify:
   - Provider appears in the popup
   - Date filtering works
   - Downloads execute correctly

## DOM Inspection Script

Run this in the billing page to get a quick overview:

```javascript
const tables = document.querySelectorAll('table');
const links = document.querySelectorAll('a[href*="pdf"], a[href*="invoice"], a[download]');
const dates = document.body.innerText.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b|\b\w+ \d{1,2}, \d{4}\b|\b\d{4}-\d{2}-\d{2}\b/g);
JSON.stringify({
  tables: tables.length,
  pdfLinks: links.length,
  sampleDates: [...new Set(dates || [])].slice(0, 5),
  sampleLinkTexts: Array.from(links).slice(0, 5).map(a => a.textContent.trim())
}, null, 2);
```

## Provider JSON Template

```json
{
  "id": "PROVIDER_SLUG",
  "name": "Provider Name",
  "icon": "EMOJI",
  "billingUrl": "https://example.com/billing",
  "readySelector": "SELECTOR_THAT_INDICATES_PAGE_LOADED",
  "extract": {
    "rows": "SELECTOR_FOR_EACH_INVOICE_ROW",
    "fields": {
      "date": { "selector": "RELATIVE_SELECTOR", "attr": "textContent" },
      "amount": { "selector": "RELATIVE_SELECTOR" },
      "downloadUrl": { "selector": "RELATIVE_SELECTOR", "attr": "href" }
    },
    "dateFormat": "auto",
    "dedup": "downloadUrl"
  },
  "download": {
    "method": "direct-link",
    "filenameTemplate": "{{name}}_Invoice_{{date}}.pdf"
  }
}
```
