import type { DiffStyle } from '../hooks/useStore';

export interface DiffPalette {
  addFg: string;
  addBg: string;
  addGutter: string;
  delFg: string;
  delBg: string;
  delGutter: string;
  hunkBg: string;
  hunkFg: string;
}

export function diffPaletteForTheme(isDark: boolean, style: DiffStyle): DiffPalette {
  if (isDark) {
    return style === 'focused'
      ? {
          addFg: '#8bd5a8',
          addBg: 'rgba(46, 160, 67, 0.24)',
          addGutter: 'rgba(46, 160, 67, 0.42)',
          delFg: '#ff938a',
          delBg: 'rgba(248, 81, 73, 0.24)',
          delGutter: 'rgba(248, 81, 73, 0.42)',
          hunkBg: 'rgba(56, 139, 253, 0.15)',
          hunkFg: '#79b8ff',
        }
      : {
          addFg: '#73c991',
          addBg: 'rgba(46, 160, 67, 0.14)',
          addGutter: 'rgba(46, 160, 67, 0.26)',
          delFg: '#ff7b72',
          delBg: 'rgba(248, 81, 73, 0.14)',
          delGutter: 'rgba(248, 81, 73, 0.26)',
          hunkBg: 'rgba(56, 139, 253, 0.1)',
          hunkFg: '#79b8ff',
        };
  }

  return style === 'focused'
    ? {
        addFg: '#116329',
        addBg: '#d9f2df',
        addGutter: '#a8ddb5',
        delFg: '#a40e26',
        delBg: '#ffe2e0',
        delGutter: '#f7b5b0',
        hunkBg: '#dff1ff',
        hunkFg: '#0550ae',
      }
    : {
        addFg: '#1a7f37',
        addBg: '#eaf7ee',
        addGutter: '#ccebd4',
        delFg: '#cf222e',
        delBg: '#fff0f0',
        delGutter: '#ffd7d5',
        hunkBg: '#eaf5ff',
        hunkFg: '#0969da',
      };
}
