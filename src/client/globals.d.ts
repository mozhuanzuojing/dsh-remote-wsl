// 运行时全局声明：client 由 esbuild 打包、运行在 DSH Web 宿主（浏览器）里。
// 这些是"宿主环境/模块接缝"，用 any 声明是增量类型化的合法边界，不是掩盖业务类型。
declare const require: any;
declare const exports: any;
declare const module: any;
declare const process: any;
declare module 'react';

interface Window {
  __dshRwUI?: any;
  __rwPrimProbe?: any;
  [key: string]: any;
}
