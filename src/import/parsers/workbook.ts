import * as workbookModule from "xlsx";
// SheetJS exposes ESM exports in Vite and a CommonJS default in Node's test runner.
export const XLSX = (Reflect.get(workbookModule, "default") ??
  workbookModule) as typeof workbookModule;
