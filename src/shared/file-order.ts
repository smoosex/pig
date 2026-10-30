/**
 * How every file list in Pig orders names within one directory: case-insensitive, with digit runs
 * compared as numbers (`file2` before `file10`). The file column, `@` suggestions and the changes tree
 * share it so the same directory never reads in two orders.
 */
export function compareFileNames(left: string, right: string): number {
  return left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' })
}
