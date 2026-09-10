import fs from 'fs';
import path from 'path';
import { deterministicStringify } from './deterministic-json';
import { skuToProductFilePath } from './product-file-path';
import type { Product } from '@/shared/types';

export interface WorkspaceDirs {
  root: string;
  products: string;
  store: string;
  exports: string;
  dotShopsite: string;
  git: string;
}

export function createWorkspaceDirs(workspacePath: string): WorkspaceDirs {
  const dirs: WorkspaceDirs = {
    root: workspacePath,
    products: path.join(workspacePath, 'products'),
    store: path.join(workspacePath, 'store'),
    exports: path.join(workspacePath, 'exports'),
    dotShopsite: path.join(workspacePath, '.baystate-cms'),
    git: path.join(workspacePath, '.git'),
  };

  // Create all dirs EXCEPT .git - that's managed by git init
  for (const [key, dir] of Object.entries(dirs)) {
    if (key === 'git') continue;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  return dirs;
}

export function writeGitignore(workspacePath: string): void {
  const gitignorePath = path.join(workspacePath, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(
      gitignorePath,
      [
        '# Bay State CMS ignores',
        '.baystate-cms/app.db',
        '.baystate-cms/secrets.json',
        '.baystate-cms/logs/',
        '.baystate-cms/temp/',
        'exports/**/*.zip',
        'exports/**/*.xml',
        '',
      ].join('\n'),
      'utf-8',
    );
  }
}

export function writeProductFile(workspacePath: string, product: Product): void {
  const productDir = path.join(workspacePath, 'products');
  if (!fs.existsSync(productDir)) {
    fs.mkdirSync(productDir, { recursive: true });
  }
  const filePath = path.join(workspacePath, skuToProductFilePath(product.sku));
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, deterministicStringify(product), 'utf-8');
}

export function readProductFile(workspacePath: string, sku: string): Product | null {
  const relPath = skuToProductFilePath(sku);
  const fullPath = path.join(workspacePath, relPath);
  if (!fs.existsSync(fullPath)) return null;
  const content = fs.readFileSync(fullPath, 'utf-8');
  return JSON.parse(content) as Product;
}

export function writeStoreConfig<T>(workspacePath: string, filename: string, data: T): void {
  const storePath = path.join(workspacePath, 'store', filename);
  fs.writeFileSync(storePath, deterministicStringify(data), 'utf-8');
}

export function readStoreConfig<T>(workspacePath: string, filename: string): T | null {
  const storePath = path.join(workspacePath, 'store', filename);
  if (!fs.existsSync(storePath)) return null;
  const content = fs.readFileSync(storePath, 'utf-8');
  return JSON.parse(content) as T;
}
