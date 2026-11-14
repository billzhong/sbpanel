// Single source of truth for prototype palettes. Role names == sbpanel token names.
// New roles: --raised (popover/menu), --border, --border-strong, --accent-text, --focus.
export const palettes = {
  neutral: {
    label: '石墨 Graphite',
    light: {
      base:'#f5f6f8', surface:'#ffffff', overlay:'#eceef2', raised:'#ffffff',
      text:'#1b1d22', subtle:'#4c5260', muted:'#646b78',
      'hl-low':'#f0f1f4','hl-med':'#dcdfe5','hl-high':'#c4c9d2',
      border:'#e0e3e8','border-strong':'#7d8492',
      accent:'#1f6a88','accent-text':'#1a6280','on-accent':'#ffffff', focus:'#1f6a88',
      good:'#18794e', warn:'#975a00', bad:'#c4302b',
      love:'#b4637a', gold:'#975a00', rose:'#b05a56', pine:'#1f6a88', foam:'#2f7d88', iris:'#7356a0',
      grid:'#e8ebef',
    },
    dark: {
      base:'#111215', surface:'#1a1c20', overlay:'#25272d', raised:'#2c2f36',
      text:'#eceef2', subtle:'#b6bbc6', muted:'#9298a4',
      'hl-low':'#1f2125','hl-med':'#33363d','hl-high':'#474b54',
      border:'#2e3138','border-strong':'#7a808c',
      accent:'#5aaed0','accent-text':'#6cbbdc','on-accent':'#06151c', focus:'#6cbbdc',
      good:'#4cc38a', warn:'#e7b448', bad:'#f2766b',
      love:'#ee7d9c', gold:'#e7b448', rose:'#eaa29f', pine:'#5aaed0', foam:'#8fd0da', iris:'#b9a2e6',
      grid:'#2a2d33',
    },
  },
  rosepine: {
    label: 'Rosé Pine',
    light: {
      base:'#faf4ed', surface:'#fffaf3', overlay:'#f2e9e1', raised:'#fffaf3',
      text:'#3c3858', subtle:'#615c7e', muted:'#67627f',
      'hl-low':'#f4ede8','hl-med':'#dfdad9','hl-high':'#cecacd',
      border:'#e6dfd9','border-strong':'#847f96',
      accent:'#286983','accent-text':'#286983','on-accent':'#fffaf3', focus:'#286983',
      good:'#276f39', warn:'#8c5806', bad:'#b4384f',
      love:'#b4637a', gold:'#ea9d34', rose:'#d7827e', pine:'#286983', foam:'#56949f', iris:'#907aa9',
      grid:'#ebe4dd',
    },
    dark: { // Rosé Pine main base under Moon surfaces => clear elevation
      base:'#191724', surface:'#232136', overlay:'#2f2c46', raised:'#393552',
      text:'#e0def4', subtle:'#b8b5d0', muted:'#9a96b6',
      'hl-low':'#2a283e','hl-med':'#44415a','hl-high':'#56526e',
      border:'#36334d','border-strong':'#8a86ad',
      accent:'#5ba3c4','accent-text':'#7fbcd6','on-accent':'#141221', focus:'#9ccfd8',
      good:'#5fc28a', warn:'#f6c177', bad:'#f28fab',
      love:'#eb6f92', gold:'#f6c177', rose:'#ea9a97', pine:'#3e8fb0', foam:'#9ccfd8', iris:'#c4a7e7',
      grid:'#2f2c45',
    },
  },
  catppuccin: {
    label: 'Catppuccin',
    light: { // Latte
      base:'#e6e9ef', surface:'#eff1f5', overlay:'#dce0e8', raised:'#ffffff',
      text:'#4c4f69', subtle:'#4f5168', muted:'#5f6177',
      'hl-low':'#e6e9ef','hl-med':'#ccd0da','hl-high':'#bcc0cc',
      border:'#d3d7e0','border-strong':'#787b8f',
      accent:'#1857d6','accent-text':'#1857d6','on-accent':'#ffffff', focus:'#1e66f5',
      good:'#2a6e1a', warn:'#875500', bad:'#b80d2a',
      love:'#d20f39', gold:'#df8e1d', rose:'#dd7878', pine:'#1e66f5', foam:'#179299', iris:'#8839ef',
      grid:'#d9dde6',
    },
    dark: { // Mocha
      base:'#11111b', surface:'#1e1e2e', overlay:'#2a2b3c', raised:'#313244',
      text:'#cdd6f4', subtle:'#bac2de', muted:'#9399b2',
      'hl-low':'#24273a','hl-med':'#3a3c51','hl-high':'#45475a',
      border:'#313244','border-strong':'#7f849c',
      accent:'#89b4fa','accent-text':'#89b4fa','on-accent':'#11111b', focus:'#b4befe',
      good:'#a6e3a1', warn:'#f9e2af', bad:'#f38ba8',
      love:'#f38ba8', gold:'#f9e2af', rose:'#f5c2e7', pine:'#89b4fa', foam:'#94e2d5', iris:'#cba6f7',
      grid:'#2a2b3c',
    },
  },
  nord: {
    label: 'Nord',
    light: {
      base:'#e5e9f0', surface:'#f3f5f8', overlay:'#d8dee9', raised:'#ffffff',
      text:'#2e3440', subtle:'#434c5e', muted:'#56607a',
      'hl-low':'#eceff4','hl-med':'#d0d7e2','hl-high':'#b9c2d0',
      border:'#d3d9e3','border-strong':'#707a8c',
      accent:'#36608c','accent-text':'#36608c','on-accent':'#ffffff', focus:'#5e81ac',
      good:'#3f6d2c', warn:'#805300', bad:'#9e3b44',
      love:'#bf616a', gold:'#d08770', rose:'#b48ead', pine:'#5e81ac', foam:'#3e7c88', iris:'#8a6aa0',
      grid:'#dde2ea',
    },
    dark: {
      base:'#1f232b', surface:'#2b303b', overlay:'#353b48', raised:'#3b4252',
      text:'#eceff4', subtle:'#d0d6e0', muted:'#a7b0c0',
      'hl-low':'#303643','hl-med':'#434c5e','hl-high':'#4c566a',
      border:'#3b4252','border-strong':'#8892a8',
      accent:'#88c0d0','accent-text':'#88c0d0','on-accent':'#1f232b', focus:'#88c0d0',
      good:'#a3be8c', warn:'#ebcb8b', bad:'#eda3a9',
      love:'#e0848c', gold:'#ebcb8b', rose:'#d08770', pine:'#81a1c1', foam:'#8fbcbb', iris:'#b48ead',
      grid:'#353b48',
    },
  },
};
// chart series stay identical across palettes (validated order); light/dark steps from current index.css
export const series = {
  light: ['#2a78d6','#eb6834','#1baf7a','#eda100','#e87ba4','#008300','#6250d6','#e34948'],
  dark:  ['#3987e5','#d95926','#199e70','#c98500','#d55181','#0ca30c','#9085e9','#e66767'],
};
export const current = {
  light: { base:'#faf4ed', surface:'#fffaf3', overlay:'#f2e9e1', raised:'#fffaf3', text:'#464261', subtle:'#797593', muted:'#9893a5', accent:'#286983','accent-text':'#286983','on-accent':'#fffaf3', good:'#0ca30c', warn:'#c98500', bad:'#d03b3b', 'hl-med':'#dfdad9','hl-high':'#cecacd', border:'#e5e0de','border-strong':'#cecacd'},
  dark: { base:'#232136', surface:'#2a273f', overlay:'#393552', raised:'#393552', text:'#e0def4', subtle:'#908caa', muted:'#6e6a86', accent:'#3e8fb0','accent-text':'#3e8fb0','on-accent':'#fffaf3', good:'#0ca30c', warn:'#fab219', bad:'#e66767', 'hl-med':'#44415a','hl-high':'#56526e', border:'#3c3953','border-strong':'#56526e'},
};
