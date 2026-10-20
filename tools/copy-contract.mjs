#!/usr/bin/env node
// 把契约快照复制到编译产物旁边：编译后的 contract/src/*.js 会以 ../schemas 相对路径读取。
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const from = join(root, "contract");
const to = join(root, "lib", "contract");

mkdirSync(to, { recursive: true });
cpSync(join(from, "schemas"), join(to, "schemas"), { recursive: true });
cpSync(join(from, "vectors"), join(to, "vectors"), { recursive: true });
cpSync(join(from, "core-dispatched-schemas.json"), join(to, "core-dispatched-schemas.json"));
cpSync(join(from, "LICENSE-upstream"), join(to, "LICENSE-upstream"));
console.log(`contract snapshot copied to ${to}`);
