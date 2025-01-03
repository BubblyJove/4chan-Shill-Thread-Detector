// ==UserScript==
// @name         4chan Shill Thread Detector
// @namespace    https://github.com/your-namespace
// @version      23.7
// @description  A chart-based highlighting tool for 4chan threads, detecting spam or 'shill' threads with BFS highlights, stable y-axis, etc.
// @author       Sneed
// @match        *://boards.4chan.org/*
// @match        *://boards.4channel.org/*
// @require      https://cdn.jsdelivr.net/npm/chart.js@4.3.0/dist/chart.umd.min.js
// @require      https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function() {
  'use strict';

  /******************************************************************************
   * lru-cache.js (inlined)
   *
   * This is a simplified version of lru-cache inlined for your script.
   * If you already have your own version, you can replace or remove accordingly.
   ******************************************************************************/
  (function(global) {

    // Basic LRU Cache
    class LRUCache {
      constructor(options = {}) {
        this.max = options.max || 100;
        this.ttl = options.ttl || 0; // in ms
        this.map = new Map();
        this.queue = new Set();
      }
      // Gets an item from the cache, updates usage.
      get(key) {
        if (!this.map.has(key)) {
          return undefined;
        }
        const record = this.map.get(key);
        // check TTL
        if (this.ttl > 0 && record.expiresAt !== null && record.expiresAt < Date.now()) {
          this.delete(key);
          return undefined;
        }
        // bump usage
        this.queue.delete(key);
        this.queue.add(key);
        return record.value;
      }
      // Sets an item into the cache.
      set(key, value) {
        const now = Date.now();
        const expiresAt = this.ttl > 0 ? now + this.ttl : null;
        this.map.set(key, { value, expiresAt });
        // bump usage
        if (this.queue.has(key)) {
          this.queue.delete(key);
        }
        this.queue.add(key);

        // evict
        if (this.map.size > this.max) {
          // evict oldest
          const oldest = this.queue.values().next().value;
          this.delete(oldest);
        }
      }
      // Check if we have a key
      has(key) {
        if (!this.map.has(key)) return false;
        const record = this.map.get(key);
        if (this.ttl > 0 && record.expiresAt !== null && record.expiresAt < Date.now()) {
          this.delete(key);
          return false;
        }
        return true;
      }
      // Delete a key
      delete(key) {
        if (!this.map.has(key)) return false;
        this.map.delete(key);
        this.queue.delete(key);
        return true;
      }
      // Clear everything
      clear() {
        this.map.clear();
        this.queue.clear();
      }
    }

    // Expose it
    global.LRU = LRUCache;

  })(window);

  /****************************************************************************
   * storage.js
   * Directory: C:/Users/User/Documents/4chan-shill-detector-extension
   *
   * Provide a globally accessible LRU cache for BFS expansions or other caching
   * needs. We use the LRU class from lru-cache (inlined above).
   ****************************************************************************/
  (function() {
    'use strict';

    // Create the LRU cache instance for BFS expansions.
    // Updated to hold more items (max=2000) and keep them longer (ttl=30 min).
    const BFSCache = new window.LRU({
      max: 2000,
      ttl: 1000 * 60 * 30  // 30 minutes
    });

    /**
     * Retrieve stored BFS edges for a given startNode key.
     * Return value is expected to be a Set (or possibly null/undefined if not found).
     */
    function getBFSChainEdges(key) {
      return BFSCache.get(key);
    }

    /**
     * Store BFS edges for the given startNode key.
     * "edges" should be a Set that you want to cache.
     */
    function setBFSChainEdges(key, edges) {
      BFSCache.set(key, edges);
    }

    /**
     * Check if we have cached edges for the given startNode key.
     */
    function hasBFSChainEdges(key) {
      return BFSCache.has(key);
    }

    /**
     * Clear the entire BFS cache.
     */
    function clearBFSCache() {
      BFSCache.clear();
    }

    // Expose these on window
    window.chanStorage = {
      getBFSChainEdges,
      setBFSChainEdges,
      hasBFSChainEdges,
      clearBFSCache
    };
  })();

  /****************************************************************************
   * utils.js
   * Directory: C:/Users/User/Documents/4chan-shill-detector-extension
   ****************************************************************************/
  window.chanUtils = (function() {
    'use strict';

    function loadSettings(storageKey) {
      try {
        const stored = localStorage.getItem(storageKey);
        return stored ? JSON.parse(stored) : {};
      } catch (err) {
        console.error('[4chan Grapher] Failed to load settings:', err);
        return {};
      }
    }

    function saveSettings(storageKey, dataObj) {
      try {
        localStorage.setItem(storageKey, JSON.stringify(dataObj));
      } catch (err) {
        console.error('[4chan Grapher] Failed to save settings:', err);
      }
    }

    function debounce(fn, delay) {
      let timerId = null;
      return function debounced(...args) {
        clearTimeout(timerId);
        timerId = setTimeout(() => {
          fn.apply(this, args);
        }, delay);
      };
    }

    function hexOrRgbaWithAlpha(baseColor, alpha) {
      try {
        const hexMatch = baseColor.trim().match(/^#([0-9A-Fa-f]{3,8})$/);
        if (hexMatch) {
          let hex = hexMatch[1];
          if (hex.length === 3) {
            hex = hex.split('').map(x => x + x).join('');
          }
          const r = parseInt(hex.slice(0, 2), 16);
          const g = parseInt(hex.slice(2, 4), 16);
          const b = parseInt(hex.slice(4, 6), 16);
          return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }
        const rgbMatch = baseColor.trim().match(/^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(,\s*[\d.]+)?\)\s*$/);
        if (rgbMatch) {
          const r = parseInt(rgbMatch[1], 10);
          const g = parseInt(rgbMatch[2], 10);
          const b = parseInt(rgbMatch[3], 10);
          return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }
        if (baseColor.indexOf('hsl') === 0) {
          return baseColor
            .replace(/hsla?\(/, 'hsla(')
            .replace(/\)$/, `, ${alpha})`);
        }
        // Default fallback
        return `rgba(0, 0, 0, ${alpha})`;
      } catch (err) {
        console.error('Error in hexOrRgbaWithAlpha:', err);
        return `rgba(0, 0, 0, ${alpha})`;
      }
    }

    return {
      loadSettings,
      saveSettings,
      debounce,
      hexOrRgbaWithAlpha
    };
  })();

  /****************************************************************************
   * global-state.js
   * Directory: C:/Users/User/Documents/4chan-shill-detector-extension
   *
   * Centralize and store all shared/global variables in a single "state" object.
   ****************************************************************************/
  (function() {
    'use strict';

    // Provide a single state object with default initial values
    const defaultState = {
      STORAGE_KEY: 'chanShillSettings',

      // Settings toggles
      debugMode: false,
      useColoredBorders: false,
      showFlagsBar: false,
      spamDetectionEnabled: true,
      enableFlagHighlight: true,
      enableHideByFlag: true,
      enableSingleFlagView: false,
      enableDotPreview: false,
      enableOnePbtidCheck: true,

      // BFS hover delay (ms)
      bfsDebounceTime: 200,

      // BFS highlight
      highlightEdges: new Set(),
      hoveredIndex: null,

      // Chart instance + config
      chart: null,
      chartConfig: null,

      // Various sets/maps used throughout
      uidColorMap: new Map(),
      hiddenFlags: new Set(),
      flagMap: new Map(),
      uniqueUIDCount: 0,

      // For flags
      hoveredFlagName: null,
      selectedSingleFlag: null,

      // For theme changes
      themeChangeTimer: null,
      cogButtonRef: null,
      cogPanelRef: null,

      // Dot preview
      hoverPreviewElem: null,
      pendingRaf: false,
      targetPreviewPosition: { x: 0, y: 0 },

      // For spam detection
      spamDetected: false,

      // 1PBTID data
      isOnePbtidThread: false,

      // Keep track of last extracted post count
      lastExtractedPostCount: 0,

      // References to header buttons
      minBtnRef: null,
      headerButtonsRefs: [],

      // Timers for BFS hover
      hoverTimer: null,
      throbberTimer: null,
      hoveredDotIndex: null,
      bfsThrobberElem: null
    };

    window.chanApp = {
      state: { ...defaultState }
    };
  })();

  /****************************************************************************
   * dom-helpers.js
   * Directory: C:/Users/User/Documents/4chan-shill-detector-extension
   *
   * Provides utilities for extracting post data from the DOM.
   ****************************************************************************/
  (function() {
    'use strict';

    let debug = false;

    /**
     * For caching preview HTML so we only build it once per postNumber.
     */
    const previewCache = new Map();

    /**
     * Keep track of the highest numeric post ID we've encountered.
     */
    let highestPostNumberSeen = 0;

    function setDebugMode(val) {
      debug = val;
    }

    function getAllPostElements() {
      let allPosts = document.querySelectorAll('.post');
      if (!allPosts || allPosts.length === 0) {
        allPosts = document.querySelectorAll('.postContainer');
      }
      return Array.from(allPosts);
    }

    function getFlagInfo(postElem) {
      // Check for Memeflags
      const polMemeFlagElem = postElem.querySelector('.bfl');
      if (polMemeFlagElem) {
        return {
          flag: 'Memeflags',
          flagHTML: ''
        };
      }
      // Normal 4chan flag
      const normalFlagElem = postElem.querySelector('.flag[class*="flag-"]');
      if (normalFlagElem) {
        const clonedSpan = normalFlagElem.cloneNode(true);
        const altOrTitle = normalFlagElem.alt || normalFlagElem.title;
        const flagName = altOrTitle && altOrTitle.trim() ? altOrTitle.trim() : 'Unknown';
        return {
          flag: flagName,
          flagHTML: clonedSpan.outerHTML
        };
      }
      return { flag: null, flagHTML: '' };
    }

    function buildPreviewHTML(msgElem, postNumber) {
      if (!msgElem) return '(No content)';
      if (!postNumber) {
        return buildTruncatedHTML(msgElem);
      }
      if (previewCache.has(postNumber)) {
        return previewCache.get(postNumber);
      }
      const truncatedHTML = buildTruncatedHTML(msgElem);
      previewCache.set(postNumber, truncatedHTML);
      return truncatedHTML;
    }

    function buildTruncatedHTML(msgElem) {
      const clonedMsg = msgElem.cloneNode(true);

      const maxTextLength = 1500;
      let currentTextCount = 0;
      const nodeQueue = [clonedMsg];

      while (nodeQueue.length) {
        const node = nodeQueue.shift();
        if (node.nodeType === Node.TEXT_NODE && node.nodeValue) {
          currentTextCount += node.nodeValue.length;
          if (currentTextCount > maxTextLength) {
            const diff = currentTextCount - maxTextLength;
            const keepLen = node.nodeValue.length - diff;
            if (keepLen > 0) {
              node.nodeValue = node.nodeValue.slice(0, keepLen) + '...';
            } else {
              node.nodeValue = '...';
            }
            break;
          }
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          const children = Array.from(node.childNodes);
          for (const child of children) {
            nodeQueue.push(child);
          }
        }
      }

      return clonedMsg.innerHTML;
    }

    function extractOnePost(postElem) {
      try {
        const postNumLink = postElem.querySelector('.postNum a');
        const dateElem = postElem.querySelector('[data-utc]');
        const msgElem  = postElem.querySelector('.postMessage');
        const uidElem  = postElem.querySelector('.posteruid');
        const postID   = postElem.id || '';

        const { flag, flagHTML } = getFlagInfo(postElem);

        // Determine the post number (string)
        let postNumber = null;
        if (postNumLink && postNumLink.textContent) {
          const textContent = postNumLink.textContent.trim();
          const m = textContent.match(/(\d+)/);
          if (m) postNumber = m[1];
        }
        // fallback from ID, e.g. "p123456"
        if (!postNumber && postID) {
          const idMatch = postID.match(/^p(\d+)$/);
          if (idMatch) {
            postNumber = idMatch[1];
          }
        }
        if (!postNumber) return null;

        // Must have valid data-utc
        if (!dateElem) return null;
        const utcVal = dateElem.getAttribute('data-utc');
        if (!utcVal) return null;
        const postTime = new Date(parseInt(utcVal, 10) * 1000);
        if (!postTime || isNaN(postTime.getTime())) {
          if (debug) console.log('Skipping post with invalid date:', postElem);
          return null;
        }

        let uid = null;
        if (uidElem && uidElem.textContent) {
          uid = uidElem.textContent.trim().replace(/ID:\s?/, '');
        }

        // Gather "reply to" postNumbers
        const replyTos = [];
        if (msgElem) {
          const anchorElems = msgElem.querySelectorAll('a[href^="#p"]');
          const textAnchors = new Set();
          anchorElems.forEach(a => {
            const mm = a.getAttribute('href').match(/#p(\d+)/);
            if (mm && mm[1]) {
              textAnchors.add(mm[1]);
            }
          });
          replyTos.push(...textAnchors);
        }

        let messageHTML = '';
        if (msgElem) {
          messageHTML = msgElem.innerHTML;
        }
        const previewHTML = buildPreviewHTML(msgElem, postNumber);

        return {
          number: postNumber,
          time: postTime,
          replyTos,
          uid,
          flag,
          flagHTML,
          messageHTML,
          previewHTML
        };
      } catch (err) {
        if (debug) console.error('Error in extractOnePost:', err);
        return null;
      }
    }

    function extractPosts() {
      const postElems = getAllPostElements();
      if (debug) console.debug(`Found ${postElems.length} post element(s).`);

      const results = [];
      for (let i = 0; i < postElems.length; i++) {
        const extracted = extractOnePost(postElems[i]);
        if (extracted) results.push(extracted);
      }

      // De-duplicate
      const deduped = [];
      const usedNums = new Set();
      for (const postObj of results) {
        if (!usedNums.has(postObj.number)) {
          usedNums.add(postObj.number);
          deduped.push(postObj);
        } else if (debug) {
          console.warn('Duplicate post number found & skipped:', postObj.number);
        }
      }
      return deduped;
    }

    function extractNewPosts() {
      const postElems = getAllPostElements();
      const newPosts = [];
      for (const postElem of postElems) {
        const extracted = extractOnePost(postElem);
        if (!extracted) continue;

        const thisID = parseInt(extracted.number, 10);
        if (!isNaN(thisID) && thisID > highestPostNumberSeen) {
          newPosts.push(extracted);
          if (thisID > highestPostNumberSeen) {
            highestPostNumberSeen = thisID;
          }
        }
      }
      if (debug && newPosts.length > 0) {
        console.debug(`extractNewPosts: Found ${newPosts.length} new post(s).`);
      }
      return newPosts;
    }

    // Expose on window
    window.chanDom = {
      setDebugMode,
      getAllPostElements,
      getFlagInfo,
      buildPreviewHTML,
      extractOnePost,
      extractPosts,
      extractNewPosts
    };
  })();

  /****************************************************************************
   * style-injection.js
   * Directory: C:/Users/User/Documents/4chan-shill-detector-extension
   *
   * Provide functions for injecting CSS (forced styles, toggle switch, BFS throbber),
   * and styling certain DOM elements.
   ****************************************************************************/
  (function() {
    'use strict';

    const FORCED_STYLE_ID = 'chanShillForcedThemeStyle';
    const TOGGLE_SWITCH_STYLE_ID = 'toggleSwitchStyleTag';
    const THROBBER_STYLE_ID = 'bfsThrobberStyleTag';

    function injectForcedCSS(textColor, replyBgColor) {
      const oldTag = document.getElementById(FORCED_STYLE_ID);
      if (oldTag) oldTag.remove();

      const styleBlock = document.createElement('style');
      styleBlock.id = FORCED_STYLE_ID;
      styleBlock.type = 'text/css';
      styleBlock.textContent = `
        /* Flag buttons */
        .flagItem {
          background-color: ${replyBgColor} !important;
          color: ${textColor} !important;
          border: 1px solid #ccc !important;
          border-radius: 4px !important;
          padding: 5px 10px !important;
          text-align: center !important;
          font-size: 14px !important;
          cursor: pointer !important;
        }

        /* Dot preview */
        #chartDotPreview {
          background-color: ${replyBgColor} !important;
          color: ${textColor} !important;
          border: 1px solid #333 !important;
          padding: 5px !important;
          font-size: 14px !important;
          border-radius: 4px !important;
        }

        /* Toggle switch containers */
        .toggleSwitchContainer {
          color: ${textColor} !important;
        }
      `;
      document.head.appendChild(styleBlock);

      // Ensure BFS throbber style is inserted
      insertThrobberStyles();
    }

    function insertToggleSwitchStyles(normalOffColor, highlightOnColor) {
      const existingTag = document.getElementById(TOGGLE_SWITCH_STYLE_ID);
      if (existingTag) existingTag.remove();

      const styleTag = document.createElement('style');
      styleTag.id = TOGGLE_SWITCH_STYLE_ID;
      styleTag.textContent = `
        :root {
          --toggle-off-bg: ${normalOffColor};
          --toggle-on-bg:  ${highlightOnColor};
        }
        .toggleSwitchContainer {
          display: flex;
          align-items: center;
          margin-bottom: 8px;
        }
        .toggleSwitchLabel {
          margin-right: 8px;
        }
        .toggleSwitchWrapper {
          position: relative;
          display: inline-block;
          width: 40px;
          height: 22px;
        }
        .toggleSwitchWrapper input {
          opacity: 0;
          width: 0;
          height: 0;
        }
        .toggleSwitchSlider {
          position: absolute;
          cursor: pointer;
          top: 0; left: 0; right: 0; bottom: 0;
          background-color: var(--toggle-off-bg) !important;
          transition: .2s;
          border-radius: 22px;
        }
        .toggleSwitchSlider:before {
          position: absolute;
          content: "";
          height: 16px;
          width: 16px;
          left: 3px;
          bottom: 3px;
          background-color: #fff !important;
          transition: .2s;
          border-radius: 50%;
        }
        input:checked + .toggleSwitchSlider {
          background-color: var(--toggle-on-bg) !important;
        }
        input:focus + .toggleSwitchSlider {
          box-shadow: 0 0 2px var(--toggle-on-bg) !important;
        }
        input:checked + .toggleSwitchSlider:before {
          transform: translateX(18px);
        }
      `;
      document.head.appendChild(styleTag);
    }

    function insertThrobberStyles() {
      if (document.getElementById(THROBBER_STYLE_ID)) return;

      const styleTag = document.createElement('style');
      styleTag.id = THROBBER_STYLE_ID;
      styleTag.textContent = `
        #bfsHoverThrobber {
          position: absolute;
          width: 18px;
          height: 18px;
          pointer-events: none;
          display: none;
          z-index: 999999;
        }
        #bfsHoverThrobber::before {
          content: "";
          display: block;
          width: 18px;
          height: 18px;
          border: 2px solid rgba(255, 0, 0, 0.4);
          border-top-color: rgba(255, 0, 0, 1.0);
          border-radius: 50%;
        }
        .throbberActive::before {
          animation: spinThrobber var(--bfsDebounceMs) linear 1 forwards;
        }
        @keyframes spinThrobber {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `;
      document.head.appendChild(styleTag);
    }

    function styleHeaderButton(button, replyBgColor, textColor) {
      button.style.backgroundColor = replyBgColor;
      button.style.color = textColor;
      button.style.border = '1px solid #ccc';
      button.style.borderRadius = '4px';
    }

    window.chanStyle = {
      injectForcedCSS,
      insertToggleSwitchStyles,
      styleHeaderButton
    };
  })();

  /****************************************************************************
   * bfs-graph.js
   * Directory: C:/Users/User/Documents/4chan-shill-detector-extension
   *
   * Provide BFS logic for building adjacency & BFS expansions, with LRU caching.
   ****************************************************************************/
  (function() {
    'use strict';

    // Pull LRU-based helpers from storage.js
    const { getBFSChainEdges, setBFSChainEdges, hasBFSChainEdges, clearBFSCache } = window.chanStorage;

    function encodeEdge(src, tgt) {
      return (src << 16) | tgt;
    }

    function decodeEdge(edge) {
      const src = edge >>> 16;
      const tgt = edge & 0xffff;
      return [src, tgt];
    }

    // stable wave sign (+1 / -1) between pairs of post numbers
    const signCache = Object.create(null);

    let opIndex = null;
    let globalAllAdj = null;

    let scratchVisited = null;
    let scratchQueue = [];
    let scratchEdges = new Set();

    function buildReplyStructures(graphData) {
      const postIndexMap = new Map();
      const replyCountMap = new Map();
      const forwardAdj = new Map();
      const reverseAdj = new Map();
      const allAdj = new Map();

      let possibleOP = 0;

      graphData.forEach((pt, idx) => {
        replyCountMap.set(pt.number, 0);
        forwardAdj.set(idx, []);
        reverseAdj.set(idx, []);
        allAdj.set(idx, new Set());
      });
      graphData.forEach((pt, idx) => {
        postIndexMap.set(pt.number, idx);
      });

      graphData.forEach((point, idx) => {
        if (point.isOP) {
          possibleOP = idx;
        }
        if (!point.replyTos) return;
        point.replyTos.forEach(refNum => {
          const targetIdx = postIndexMap.get(refNum);
          if (typeof targetIdx !== 'undefined') {
            forwardAdj.get(idx).push(targetIdx);
            reverseAdj.get(targetIdx).push(idx);
            replyCountMap.set(refNum, (replyCountMap.get(refNum) || 0) + 1);
            allAdj.get(idx).add(targetIdx);
            allAdj.get(targetIdx).add(idx);
          }
        });
      });

      opIndex = possibleOP;
      globalAllAdj = allAdj;

      return { postIndexMap, replyCountMap, forwardAdj, reverseAdj };
    }

    function refreshBFSCache(forwardAdj, reverseAdj, numberOfPosts) {
      clearBFSCache();
      if (!globalAllAdj) {
        console.warn('[bfs-graph] refreshBFSCache called before globalAllAdj was set.');
        return;
      }
      for (let i = 0; i < numberOfPosts; i++) {
        const edges = gatherUndirectedChainEdges(i, forwardAdj, reverseAdj, numberOfPosts);
        setBFSChainEdges(i, edges);
      }
    }

    function gatherUndirectedChainEdges(startNode, forwardAdj, reverseAdj, numberOfPosts) {
      if (!globalAllAdj) {
        console.warn('[bfs-graph] gatherUndirectedChainEdges called before globalAllAdj was set.');
        return new Set();
      }
      if (!scratchVisited || scratchVisited.length !== numberOfPosts) {
        scratchVisited = new Array(numberOfPosts).fill(false);
      } else {
        scratchVisited.fill(false);
      }
      scratchQueue.length = 0;
      scratchEdges.clear();

      scratchVisited[startNode] = true;
      scratchQueue.push(startNode);

      while (scratchQueue.length > 0) {
        const curr = scratchQueue.shift();
        if (opIndex !== null && curr === opIndex && curr !== startNode) {
          continue;
        }
        const neighbors = globalAllAdj.get(curr);
        if (!neighbors) continue;

        for (const nb of neighbors) {
          if (forwardAdj.get(curr).includes(nb)) {
            scratchEdges.add(encodeEdge(curr, nb));
          }
          if (forwardAdj.get(nb).includes(curr)) {
            scratchEdges.add(encodeEdge(nb, curr));
          }
          if (!scratchVisited[nb]) {
            scratchVisited[nb] = true;
            scratchQueue.push(nb);
          }
        }
      }
      return new Set(scratchEdges);
    }

    function fallbackBFS(startNode, forwardAdj, reverseAdj, numberOfPosts) {
      return gatherUndirectedChainEdges(startNode, forwardAdj, reverseAdj, numberOfPosts);
    }

    function computeHighlightedEdges(hoverIdxOrIdxs, forwardAdj, reverseAdj) {
      if (hoverIdxOrIdxs == null) {
        return new Set();
      }
      const startNodes = Array.isArray(hoverIdxOrIdxs) ? hoverIdxOrIdxs : [hoverIdxOrIdxs];
      if (!startNodes.length) {
        return new Set();
      }
      const numPosts = forwardAdj.size;
      const unionEdges = new Set();

      for (const start of startNodes) {
        if (hasBFSChainEdges(start)) {
          const cachedEdges = getBFSChainEdges(start);
          if (cachedEdges) {
            cachedEdges.forEach(e => unionEdges.add(e));
            continue;
          }
        }
        const edges = fallbackBFS(start, forwardAdj, reverseAdj, numPosts);
        setBFSChainEdges(start, edges);
        edges.forEach(e => unionEdges.add(e));
      }
      return unionEdges;
    }

    function getCubicBezierControls(postNumA, postNumB, x1, y1, x2, y2, debugMode = false) {
      const smaller = Math.min(postNumA, postNumB);
      const larger  = Math.max(postNumA, postNumB);
      const key = `${smaller}-${larger}`;
      let sign;

      if (Object.prototype.hasOwnProperty.call(signCache, key)) {
        sign = signCache[key];
      } else {
        let hash = 0;
        for (let i = 0; i < key.length; i++) {
          hash = ((hash << 5) - hash) + key.charCodeAt(i);
          hash |= 0;
        }
        sign = (hash % 2 === 0) ? 1 : -1;
        signCache[key] = sign;
      }

      const dx = x2 - x1;
      const dy = y2 - y1;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist === 0) {
        if (debugMode) {
          console.warn('[bfs-graph] zero distance in getCubicBezierControls:', postNumA, postNumB);
        }
        return { cx1: x1, cy1: y1, cx2: x2, cy2: y2 };
      }

      let offset = 0.2 * dist;
      if (offset > 60) {
        offset = 60;
      }

      const cx1 = x1 + dx / 3;
      const cy1 = y1 + dy / 3 + sign * offset;
      const cx2 = x1 + (2 * dx) / 3;
      const cy2 = y1 + (2 * dy) / 3 - sign * offset;

      return { cx1, cy1, cx2, cy2 };
    }

    window.chanBFS = {
      buildReplyStructures,
      refreshBFSCache,
      computeHighlightedEdges,
      getCubicBezierControls
    };
  })();

  /****************************************************************************
   * chart-setup.js
   * Directory: C:/Users/User/Documents/4chan-shill-detector-extension
   *
   * Provide Chart.js plugin definitions and helper to create the chart.
   ****************************************************************************/
  (function() {
    'use strict';

    const { getCubicBezierControls } = window.chanBFS;

    function encodeEdge(src, tgt) {
      return (src << 16) | tgt;
    }

    const replyLinesPlugin = {
      id: 'replyLinesPlugin',
      beforeDatasetsDraw(chart, args, pluginOptions) {
        try {
          const {
            graphData,
            forwardAdj,
            reverseAdj,
            connectionColor,
            shouldHighlightFlagFn,
            hoveredFlagName,
            enableSingleFlagView,
            selectedSingleFlag,
            highlightEdges,
            debugMode
          } = pluginOptions || {};

          if (!graphData || graphData.length === 0) return;

          const { ctx, scales, chartArea } = chart;
          const { left, right, top, bottom } = chartArea;

          if (!pluginOptions.cachedCoords) {
            pluginOptions.cachedCoords = { xCoords: [], yCoords: [], dataHash: null };
          }

          if (
            !pluginOptions.cachedCoords.dataHash ||
            pluginOptions.cachedCoords.dataHash !== graphData.length
          ) {
            const len = graphData.length;
            pluginOptions.cachedCoords.xCoords = new Array(len);
            pluginOptions.cachedCoords.yCoords = new Array(len);

            for (let i = 0; i < len; i++) {
              const d = graphData[i];
              pluginOptions.cachedCoords.xCoords[i] = scales.x.getPixelForValue(d.x);
              pluginOptions.cachedCoords.yCoords[i] = scales.y.getPixelForValue(d.y);
            }
            pluginOptions.cachedCoords.dataHash = graphData.length;
          }

          const xCoords = pluginOptions.cachedCoords.xCoords;
          const yCoords = pluginOptions.cachedCoords.yCoords;

          ctx.save();
          ctx.beginPath();
          ctx.rect(left, top, chartArea.width, chartArea.height);
          ctx.clip();

          for (let i = 0; i < graphData.length; i++) {
            const x1 = xCoords[i];
            const y1 = yCoords[i];
            if (x1 == null || y1 == null) continue;

            const nextNodes = forwardAdj.get(i) || [];
            for (let k = 0; k < nextNodes.length; k++) {
              const j = nextNodes[k];
              const x2 = xCoords[j];
              const y2 = yCoords[j];
              if (x2 == null || y2 == null) continue;

              const edgeEncoded = encodeEdge(i, j);
              const isBfsHighlighted = highlightEdges.has(edgeEncoded);

              let strokeAlpha = isBfsHighlighted ? 0.8 : 0.15;
              let strokeWidth = isBfsHighlighted ? 1.2 : 0.8;

              const flagA = graphData[i].flag;
              const flagB = graphData[j].flag;

              if (hoveredFlagName && !isBfsHighlighted) {
                if (flagA !== hoveredFlagName && flagB !== hoveredFlagName) {
                  strokeAlpha = 0.05;
                }
              }
              if (!shouldHighlightFlagFn(flagA) || !shouldHighlightFlagFn(flagB)) {
                strokeAlpha = 0;
              }
              if (enableSingleFlagView && selectedSingleFlag) {
                if (flagA !== selectedSingleFlag && flagB !== selectedSingleFlag) {
                  strokeAlpha = 0;
                }
              }
              if (strokeAlpha <= 0) continue;

              const { hexOrRgbaWithAlpha } = window.chanUtils;
              ctx.strokeStyle = hexOrRgbaWithAlpha(connectionColor, strokeAlpha);
              ctx.lineWidth = strokeWidth;

              if (
                (x1 < left && x2 < left) ||
                (x1 > right && x2 > right) ||
                (y1 < top && y2 < top) ||
                (y1 > bottom && y2 > bottom)
              ) {
                continue;
              }

              const postNumA = graphData[i].number;
              const postNumB = graphData[j].number;
              const { cx1, cy1, cx2, cy2 } = getCubicBezierControls(
                postNumA, postNumB, x1, y1, x2, y2, debugMode
              );

              ctx.beginPath();
              ctx.moveTo(x1, y1);
              ctx.bezierCurveTo(cx1, cy1, cx2, cy2, x2, y2);
              ctx.stroke();
            }
          }

          ctx.restore();
        } catch (err) {
          if (pluginOptions && pluginOptions.debugMode) {
            console.error('Error in replyLinesPlugin beforeDatasetsDraw:', err);
          }
        }
      }
    };

    const spamLabelPlugin = {
      id: 'spamLabelPlugin',
      afterDraw(chart, args, pluginOptions) {
        const { spamDetected, isOnePbtidThread } = pluginOptions || {};
        if (!spamDetected && !isOnePbtidThread) return;

        const { ctx, chartArea } = chart;
        let labelText = '';
        if (spamDetected) labelText = 'SPAM DETECTED';
        if (isOnePbtidThread) {
          labelText = labelText ? (labelText + ' | 1PBTID') : '1PBTID';
        }
        if (!labelText) return;

        ctx.save();
        ctx.font = 'bold 14px sans-serif';
        ctx.fillStyle = 'red';
        ctx.fillText(labelText, chartArea.left + 10, chartArea.top + 20);
        ctx.restore();
      }
    };

    function initializeChartJSPlugins(debugMode) {
      try {
        if (typeof Chart !== 'undefined') {
          Chart.register(replyLinesPlugin, spamLabelPlugin);
          if (debugMode) {
            console.debug('[chart-setup] Chart.js plugins registered.');
          }
        } else {
          if (debugMode) {
            console.warn('[chart-setup] Chart.js not found. Check your @require or import.');
          }
        }
      } catch (err) {
        if (debugMode) {
          console.error('Error registering Chart plugins:', err);
        }
      }
    }

    function createChartInstance(ctx, chartConfig) {
      return new Chart(ctx, chartConfig);
    }

    window.chanChartSetup = {
      initializeChartJSPlugins,
      createChartInstance
    };
  })();

  /****************************************************************************
   * content-script.js
   * Directory: C:/Users/User/Documents/4chan-shill-detector-extension
   *
   * The main entry point for our 4chan extension. Coordinates BFS logic,
   * chart setup, DOM queries, auto-updates, and state transitions.
   ****************************************************************************/
  (function() {
    'use strict';

    const {
      loadSettings,
      saveSettings,
      debounce,
      hexOrRgbaWithAlpha
    } = window.chanUtils;

    const {
      setDebugMode: setDomDebugMode,
      extractPosts,
      getAllPostElements,
      extractOnePost
    } = window.chanDom;

    const {
      buildReplyStructures,
      computeHighlightedEdges
    } = window.chanBFS;

    const {
      initializeChartJSPlugins,
      createChartInstance
    } = window.chanChartSetup;

    const { state } = window.chanApp;

    const {
      injectForcedCSS,
      insertToggleSwitchStyles,
      styleHeaderButton
    } = window.chanStyle;

    // 1) Load & Apply Saved Settings
    let settings = loadSettings(state.STORAGE_KEY);

    state.debugMode            = settings.debugMode            ?? false;
    state.useColoredBorders    = settings.useColoredBorders    ?? false;
    state.showFlagsBar         = settings.showFlagsBar         ?? false;
    state.spamDetectionEnabled = settings.spamDetectionEnabled ?? true;
    state.enableFlagHighlight  = settings.enableFlagHighlight  ?? true;
    state.enableHideByFlag     = settings.enableHideByFlag     ?? true;
    state.enableSingleFlagView = settings.enableSingleFlagView ?? false;
    state.enableDotPreview     = settings.enableDotPreview     ?? false;
    state.enableOnePbtidCheck  = settings.enableOnePbtidCheck  ?? true;
    state.bfsDebounceTime      = settings.bfsDebounceTime      ?? 200;
    setDomDebugMode(state.debugMode);

    if (!Object.prototype.hasOwnProperty.call(state, 'lastHoveredIndex')) {
      state.lastHoveredIndex = null;
    }
    if (!state.rawHTMLMap) {
      state.rawHTMLMap = new Map();
    }
    if (!state.postCache) {
      state.postCache = new Map();
    }

    function log(...args) {
      if (state.debugMode) {
        console.log('[4chan Grapher]:', ...args);
      }
    }

    function persistSettings() {
      settings.debugMode            = state.debugMode;
      settings.useColoredBorders    = state.useColoredBorders;
      settings.showFlagsBar         = state.showFlagsBar;
      settings.spamDetectionEnabled = state.spamDetectionEnabled;
      settings.enableFlagHighlight  = state.enableFlagHighlight;
      settings.enableHideByFlag     = state.enableHideByFlag;
      settings.enableSingleFlagView = state.enableSingleFlagView;
      settings.enableDotPreview     = state.enableDotPreview;
      settings.enableOnePbtidCheck  = state.enableOnePbtidCheck;
      settings.bfsDebounceTime      = state.bfsDebounceTime;
      settings.hiddenFlags = Array.from(state.hiddenFlags);

      saveSettings(state.STORAGE_KEY, settings);
    }

    // 2) Thread & URL Helpers
    function getThreadID() {
      const url = window.location.href;
      const match = url.match(/thread\/(\d+)/);
      return match ? match[1] : null;
    }

    function hashStringToColor(str) {
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0; // Convert to 32bit integer
      }
      const hue = Math.abs(hash) % 360;
      return `hsl(${hue},70%,50%)`;
    }

    function shouldHighlightFlag(flagName) {
      if (!flagName) return false;
      if (state.hiddenFlags.has(flagName)) return false;
      if (
        state.enableSingleFlagView &&
        state.selectedSingleFlag &&
        state.selectedSingleFlag !== flagName
      ) {
        return false;
      }
      return true;
    }

    // 3) Dynamic Color Detection
    let cachedColors = {
      textColor: '#fff',
      gridLineColor: 'rgba(128,128,128,0.1)',
      connectionColor: 'rgba(30,144,255,1)',
      replyBgColor: '#ccc'
    };

    function getDynamicColors() {
      try {
        let textColor = cachedColors.textColor;
        const postMsg = document.querySelector('.postMessage');
        if (postMsg) {
          const c = window.getComputedStyle(postMsg).color;
          if (c) textColor = c;
        } else {
          const c = window.getComputedStyle(document.body).color;
          if (c) textColor = c;
        }
        let gridLineColor = cachedColors.gridLineColor;
        const hr = document.querySelector('hr');
        if (hr) {
          const hrStyle = window.getComputedStyle(hr);
          if (hrStyle.borderTopColor) {
            gridLineColor = hrStyle.borderTopColor;
          }
        }
        let connectionColor = cachedColors.connectionColor;
        const backlink = document.querySelector('a.backlink');
        if (backlink) {
          const bStyle = window.getComputedStyle(backlink).color;
          if (bStyle) connectionColor = bStyle;
        }
        let replyBgColor = cachedColors.replyBgColor;
        const replyDiv = document.querySelector('.reply');
        if (replyDiv) {
          const repStyle = window.getComputedStyle(replyDiv).backgroundColor;
          if (repStyle) replyBgColor = repStyle;
        }

        cachedColors = {
          textColor,
          gridLineColor,
          connectionColor,
          replyBgColor
        };
      } catch (err) {
        if (state.debugMode) console.error('Error in getDynamicColors:', err);
      }
    }

    // 4) Theme Observer
    function setupThemeObserver(onThemeChanged) {
      const callback = () => {
        if (state.themeChangeTimer) {
          clearTimeout(state.themeChangeTimer);
        }
        state.themeChangeTimer = setTimeout(() => {
          getDynamicColors();
          injectForcedCSS(cachedColors.textColor, cachedColors.replyBgColor);
          if (onThemeChanged) onThemeChanged();
        }, 0);
      };

      try {
        const observerHtml = new MutationObserver(callback);
        observerHtml.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['class', 'data-theme', 'style'],
          childList: false,
          subtree: false
        });
        const observerBody = new MutationObserver(callback);
        observerBody.observe(document.body, {
          attributes: true,
          attributeFilter: ['style', 'class'],
          childList: false,
          subtree: false
        });
      } catch (err) {
        if (state.debugMode) console.error('Error in setupThemeObserver:', err);
      }
    }

    // 5) Spam Detection
    function checkForSpamTrend(graphData) {
      if (!state.spamDetectionEnabled) return false;
      if (graphData.length < 5 || graphData.length > 1000) return false;

      const firstTime = graphData[0].x.getTime();
      const xs = [];
      const ys = [];
      graphData.forEach((d, i) => {
        const minutesSinceFirst = (d.x.getTime() - firstTime) / 60000;
        xs.push(minutesSinceFirst);
        ys.push(i + 1);
      });
      const r = pearsonCorrelation(xs, ys);
      return (r >= 0.99);
    }

    function pearsonCorrelation(xArray, yArray) {
      const n = xArray.length;
      if (n !== yArray.length || n < 2) return 0;
      const meanX = xArray.reduce((a, b) => a + b, 0) / n;
      const meanY = yArray.reduce((a, b) => a + b, 0) / n;

      let num = 0, denomX = 0, denomY = 0;
      for (let i = 0; i < n; i++) {
        const dx = xArray[i] - meanX;
        const dy = yArray[i] - meanY;
        num += dx * dy;
        denomX += dx * dx;
        denomY += dy * dy;
      }
      if (denomX === 0 || denomY === 0) return 0;
      return num / Math.sqrt(denomX * denomY);
    }

    // 6) Flags Bar
    let existingFlagSpans = [];

    function buildFlagsSummaryBar(graphData, uniqueUIDCount) {
      state.flagMap.clear();

      existingFlagSpans.forEach(obj => {
        obj.span.removeEventListener('mousedown', obj.mousedownListener);
        obj.span.removeEventListener('click', obj.clickListener);
        obj.span.removeEventListener('mouseover', obj.mouseoverListener);
        obj.span.removeEventListener('mouseout', obj.mouseoutListener);
      });
      existingFlagSpans = [];

      graphData.forEach(p => {
        if (p.flag) {
          const nameKey = p.flag.trim();
          if (!state.flagMap.has(nameKey)) {
            state.flagMap.set(nameKey, {
              count: 0,
              flagHTML: p.flagHTML
            });
          }
          state.flagMap.get(nameKey).count++;
        }
      });

      if (state.flagMap.size === 0) {
        return null;
      }

      let flagArray = [...state.flagMap.entries()].sort((a, b) => b[1].count - a[1].count);
      const memeflagsIndex = flagArray.findIndex(([fn]) => fn === 'Memeflags');
      if (memeflagsIndex !== -1) {
        const [memefName, memefVal] = flagArray[memeflagsIndex];
        flagArray.splice(memeflagsIndex, 1);
        flagArray.push([memefName, memefVal]);
      }

      const bar = document.createElement('div');
      bar.id = 'flagsSummaryBar';
      bar.style.display = state.showFlagsBar ? 'flex' : 'none';
      bar.style.flexWrap = 'wrap';
      bar.style.justifyContent = 'center';
      bar.style.alignItems = 'center';
      bar.style.textAlign = 'center';
      bar.style.marginBottom = '8px';
      bar.style.padding = '4px';

      const frag = document.createDocumentFragment();

      flagArray.forEach(([flagName, info]) => {
        const count = info.count;
        const fSpan = document.createElement('span');
        fSpan.classList.add('flagItem');
        fSpan.dataset.flagName = flagName;
        fSpan.style.margin = '4px';

        if (info.flagHTML) {
          const tmp = document.createElement('span');
          tmp.innerHTML = info.flagHTML;
          fSpan.appendChild(tmp.firstChild);
          fSpan.appendChild(document.createTextNode(` (${count}) `));
        } else {
          fSpan.textContent = `${flagName} (${count}) `;
        }

        const mousedownListener = (evt) => {
          if (evt.shiftKey) {
            evt.preventDefault();
            evt.stopPropagation();
          }
        };
        const clickListener = (evt) => {
          if (evt.shiftKey) {
            evt.preventDefault();
            evt.stopPropagation();
            const isHidden = state.hiddenFlags.has(flagName);
            if (!state.enableHideByFlag) return;
            if (isHidden) {
              state.hiddenFlags.delete(flagName);
              fSpan.style.opacity = '';
            } else {
              state.hiddenFlags.add(flagName);
              fSpan.style.opacity = '0.4';
            }
            persistSettings();
            state.hoveredFlagName = null;
            state.highlightEdges.clear();
            if (state.chart) state.chart.update();
          } else {
            const currentlyHidden = state.hiddenFlags.has(flagName);
            if (currentlyHidden) {
              state.hiddenFlags.delete(flagName);
            }
            if (state.enableSingleFlagView) {
              if (state.selectedSingleFlag === flagName) {
                state.selectedSingleFlag = null;
              } else {
                state.selectedSingleFlag = flagName;
              }
            }
            persistSettings();
            state.hoveredFlagName = null;
            state.highlightEdges.clear();
            if (state.chart) state.chart.update();
          }
        };
        const mouseoverListener = () => {
          if (!state.enableFlagHighlight) return;
          if (state.hiddenFlags.has(flagName)) return;
          if (
            state.enableSingleFlagView &&
            state.selectedSingleFlag &&
            state.selectedSingleFlag !== flagName
          ) {
            return;
          }
          state.hoveredFlagName = flagName;
          const siblings = bar.querySelectorAll('.flagItem');
          siblings.forEach(s => {
            if (s !== fSpan) {
              s.style.opacity = '0.3';
            } else {
              if (state.hiddenFlags.has(flagName)) {
                s.style.opacity = '0.4';
              } else {
                s.style.opacity = '1.0';
              }
            }
          });
          if (state.chart && state.chart.data && state.chart.data.datasets[0]) {
            const ds = state.chart.data.datasets[0];
            const forwardAdj = state.chart.options.plugins.replyLinesPlugin.forwardAdj;
            const reverseAdj = state.chart.options.plugins.replyLinesPlugin.reverseAdj;
            if (forwardAdj && reverseAdj) {
              const startNodes = [];
              ds.data.forEach((pt, idx) => {
                if (pt.flag === flagName) {
                  startNodes.push(idx);
                }
              });
              const newEdges = computeHighlightedEdges(startNodes, forwardAdj, reverseAdj);
              state.highlightEdges.clear();
              for (const e of newEdges) {
                state.highlightEdges.add(e);
              }
            }
          }
          if (state.chart) state.chart.update();
        };
        const mouseoutListener = () => {
          if (!state.enableFlagHighlight) return;
          if (state.hiddenFlags.has(flagName)) return;
          if (
            state.enableSingleFlagView &&
            state.selectedSingleFlag &&
            state.selectedSingleFlag !== flagName
          ) {
            return;
          }
          state.hoveredFlagName = null;
          updateFlagBarStyles(bar);
          state.highlightEdges.clear();
          if (state.chart) state.chart.update();
        };

        fSpan.addEventListener('mousedown', mousedownListener);
        fSpan.addEventListener('click', clickListener);
        fSpan.addEventListener('mouseover', mouseoverListener);
        fSpan.addEventListener('mouseout', mouseoutListener);

        existingFlagSpans.push({
          span: fSpan,
          mousedownListener,
          clickListener,
          mouseoverListener,
          mouseoutListener
        });

        if (state.hiddenFlags.has(flagName)) {
          fSpan.style.opacity = '0.4';
        }
        frag.appendChild(fSpan);
      });

      if (uniqueUIDCount > 0) {
        const idSpan = document.createElement('span');
        idSpan.style.marginLeft = '16px';
        idSpan.textContent = `UIDs: ${uniqueUIDCount}`;
        frag.appendChild(idSpan);
      }

      bar.appendChild(frag);
      return bar;
    }

    function updateFlagBarStyles(bar) {
      const siblings = bar.querySelectorAll('.flagItem');
      siblings.forEach(s => {
        const fName = s.dataset.flagName;
        if (state.hiddenFlags.has(fName)) {
          s.style.opacity = '0.4';
        } else if (state.selectedSingleFlag && fName !== state.selectedSingleFlag) {
          s.style.opacity = '0.2';
        } else {
          s.style.opacity = '';
        }
      });
    }

    // 7) 4chan X Observer
    function updateIPCount(uniqueUIDCount) {
      const fourXipCount = document.querySelector('#thread-stats #ip-count');
      if (fourXipCount && fourXipCount.textContent.trim() === '?') {
        fourXipCount.textContent = `${uniqueUIDCount}`;
      }
      const ipCountSpanX = document.querySelector('span#ip-count');
      if (ipCountSpanX) {
        ipCountSpanX.textContent = `${uniqueUIDCount}`;
      }
      const ipCountTs = document.querySelector('.ts-ip-count');
      if (ipCountTs) {
        ipCountTs.textContent = `${uniqueUIDCount}`;
      }
      const fallbackContainer = document.querySelector('#header, #threads, .boardTitle, body');
      if (!fourXipCount && !ipCountSpanX && !ipCountTs && fallbackContainer) {
        const newSpan = document.createElement('span');
        newSpan.id = 'ip-count';
        newSpan.style.marginLeft = '8px';
        newSpan.textContent = `IDs: ${uniqueUIDCount}`;
        fallbackContainer.appendChild(newSpan);
      }
    }

    function setup4chanXObserver() {
      const stats = document.querySelector('#thread-stats');
      if (!stats) {
        return;
      }
      const observer = new MutationObserver(() => {
        const ipCountElem = stats.querySelector('#ip-count');
        if (ipCountElem && ipCountElem.textContent.trim() === '?') {
          ipCountElem.textContent = `${state.uniqueUIDCount}`;
        }
      });
      observer.observe(stats, {
        childList: true,
        subtree: true,
        characterData: true
      });
    }

    // 8) Toggles & Cog Menu
    function createToggleSwitch(labelText, isChecked, onChange) {
      const container = document.createElement('div');
      container.classList.add('toggleSwitchContainer');

      const label = document.createElement('span');
      label.classList.add('toggleSwitchLabel');
      label.textContent = labelText;

      const wrapper = document.createElement('label');
      wrapper.classList.add('toggleSwitchWrapper');

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = isChecked;

      const slider = document.createElement('span');
      slider.classList.add('toggleSwitchSlider');

      input.addEventListener('change', (e) => {
        onChange(e.target.checked);
      });

      wrapper.appendChild(input);
      wrapper.appendChild(slider);

      container.appendChild(label);
      container.appendChild(wrapper);
      return container;
    }

    function createCogMenu() {
      const frag = document.createDocumentFragment();

      const cogContainer = document.createElement('div');
      cogContainer.id = 'cogMenuContainer';
      cogContainer.style.position   = 'relative';
      cogContainer.style.zIndex     = '9999';
      cogContainer.style.cursor     = 'pointer';
      cogContainer.style.fontSize   = '14px';
      cogContainer.style.display    = 'flex';
      cogContainer.style.alignItems = 'center';

      const cogButton = document.createElement('div');
      cogButton.textContent = '⚙';
      cogButton.style.fontSize     = '18px';
      cogButton.style.padding      = '5px 10px';
      cogButton.style.border       = '1px solid #ccc';
      cogButton.style.borderRadius = '4px';
      cogButton.style.textAlign    = 'center';
      cogButton.style.display      = 'inline-block';

      const panel = document.createElement('div');
      panel.style.display       = 'none';
      panel.style.flexDirection = 'column';
      panel.style.position      = 'absolute';
      panel.style.top           = '40px';
      panel.style.left          = '0';
      panel.style.padding       = '10px';
      panel.style.border        = '1px solid #ccc';
      panel.style.borderRadius  = '4px';
      panel.style.minWidth      = '180px';

      const { replyBgColor, textColor } = cachedColors;
      cogButton.style.backgroundColor = replyBgColor;
      cogButton.style.color           = textColor;
      panel.style.backgroundColor     = replyBgColor;
      panel.style.color               = textColor;

      state.cogButtonRef = cogButton;
      state.cogPanelRef  = panel;

      // ID Borders
      const idBordersToggle = createToggleSwitch(
        'ID Borders',
        state.useColoredBorders,
        (checkedVal) => {
          state.useColoredBorders = checkedVal;
          persistSettings();
          if (state.chart) state.chart.update();
        }
      );
      panel.appendChild(idBordersToggle);

      // Show Flags
      const showFlagsToggle = createToggleSwitch(
        'Show Flags',
        state.showFlagsBar,
        (checkedVal) => {
          state.showFlagsBar = checkedVal;
          persistSettings();
          const bar = document.getElementById('flagsSummaryBar');
          if (bar) {
            bar.style.display = state.showFlagsBar ? 'flex' : 'none';
          }
        }
      );
      panel.appendChild(showFlagsToggle);

      // Spam Detection
      const spamToggle = createToggleSwitch(
        'Spam Detection',
        state.spamDetectionEnabled,
        (checkedVal) => {
          state.spamDetectionEnabled = checkedVal;
          persistSettings();
          if (state.spamDetectionEnabled && state.chart && state.chart.data?.datasets[0]) {
            const data = state.chart.data.datasets[0].data;
            state.spamDetected = checkForSpamTrend(data);
          } else {
            state.spamDetected = false;
          }
          if (state.chart) state.chart.update();
        }
      );
      panel.appendChild(spamToggle);

      // Flag-based Highlight
      const highlightToggle = createToggleSwitch(
        'Flag-based Highlight',
        state.enableFlagHighlight,
        (checkedVal) => {
          state.enableFlagHighlight = checkedVal;
          persistSettings();
        }
      );
      panel.appendChild(highlightToggle);

      // Flag-based Hide
      const hideByFlagToggle = createToggleSwitch(
        'Flag-based Hide',
        state.enableHideByFlag,
        (checkedVal) => {
          state.enableHideByFlag = checkedVal;
          persistSettings();
        }
      );
      panel.appendChild(hideByFlagToggle);

      // Debug Logging
      const debugToggle = createToggleSwitch(
        'Debug Logging',
        state.debugMode,
        (checkedVal) => {
          state.debugMode = checkedVal;
          setDomDebugMode(state.debugMode);
          persistSettings();
        }
      );
      panel.appendChild(debugToggle);

      // Single-Flag View
      const singleFlagToggle = createToggleSwitch(
        'Single-Flag View',
        state.enableSingleFlagView,
        (checkedVal) => {
          state.enableSingleFlagView = checkedVal;
          state.selectedSingleFlag = null;
          persistSettings();
          if (state.chart) state.chart.update();
          const bar = document.getElementById('flagsSummaryBar');
          if (bar) {
            updateFlagBarStyles(bar);
          }
        }
      );
      panel.appendChild(singleFlagToggle);

      // Dot Preview
      const dotPreviewToggle = createToggleSwitch(
        'Dot Preview',
        state.enableDotPreview,
        (checkedVal) => {
          state.enableDotPreview = checkedVal;
          persistSettings();
          if (!state.enableDotPreview && state.hoverPreviewElem) {
            state.hoverPreviewElem.style.display = 'none';
          }
        }
      );
      panel.appendChild(dotPreviewToggle);

      // 1PBTID Label
      const onePbtidToggle = createToggleSwitch(
        '1PBTID Label',
        state.enableOnePbtidCheck,
        (checkedVal) => {
          state.enableOnePbtidCheck = checkedVal;
          persistSettings();
          if (state.chart) state.chart.update();
        }
      );
      panel.appendChild(onePbtidToggle);

      // BFS Hover Delay slider
      const bfsLabel = document.createElement('div');
      bfsLabel.textContent = 'BFS Hover Delay (ms):';
      bfsLabel.style.marginTop = '8px';
      panel.appendChild(bfsLabel);

      const bfsSliderContainer = document.createElement('div');
      bfsSliderContainer.style.display = 'flex';
      bfsSliderContainer.style.alignItems = 'center';
      bfsSliderContainer.style.marginBottom = '6px';

      const bfsSlider = document.createElement('input');
      bfsSlider.type = 'range';
      bfsSlider.min = '50';
      bfsSlider.max = '2000';
      bfsSlider.step = '50';
      bfsSlider.value = state.bfsDebounceTime;
      bfsSlider.style.flex = '1';

      const bfsValueSpan = document.createElement('span');
      bfsValueSpan.style.marginLeft = '6px';
      bfsValueSpan.textContent = `(${state.bfsDebounceTime} ms)`;

      bfsSlider.addEventListener('input', (evt) => {
        const val = parseInt(evt.target.value, 10);
        state.bfsDebounceTime = val;
        persistSettings();
        bfsValueSpan.textContent = `(${val} ms)`;
      });

      bfsSliderContainer.appendChild(bfsSlider);
      bfsSliderContainer.appendChild(bfsValueSpan);
      panel.appendChild(bfsSliderContainer);

      cogButton.addEventListener('click', () => {
        panel.style.display = (panel.style.display === 'none') ? 'flex' : 'none';
      });

      cogContainer.appendChild(cogButton);
      cogContainer.appendChild(panel);
      frag.appendChild(cogContainer);
      return frag;
    }

    // 9) Minimize Button
    function createMinimizeButton() {
      const minBtn = document.createElement('div');
      minBtn.id = 'minimizeButton';
      minBtn.style.cursor     = 'pointer';
      minBtn.style.fontSize   = '14px';
      minBtn.style.padding    = '5px 10px';
      minBtn.style.border     = '1px solid #ccc';
      minBtn.style.borderRadius = '4px';
      minBtn.style.backgroundColor = '#eee';
      minBtn.textContent = '-';

      let isMinimized = false;
      minBtn.addEventListener('click', () => {
        isMinimized = !isMinimized;
        const container = document.getElementById('threadActivityChartContainer');
        if (!container) return;
        if (isMinimized) {
          if (state.chart) {
            state.chart.destroy();
            state.chart = null;
          }
          if (state.canvas) {
            state.canvas.remove();
            state.canvas = null;
            state.ctx = null;
          }
          container.style.height = '40px';
          minBtn.textContent = '+';
        } else {
          container.style.height = '400px';
          const newCanvas = document.createElement('canvas');
          newCanvas.style.width  = '100%';
          newCanvas.style.height = '100%';
          container.appendChild(newCanvas);

          state.canvas = newCanvas;
          state.ctx    = newCanvas.getContext('2d');
          if (state.chartConfig) {
            state.chart = createChartInstance(state.ctx, state.chartConfig);
          }
          minBtn.textContent = '-';
        }
      });

      state.minBtnRef = minBtn;
      state.headerButtonsRefs.push(minBtn);
      return minBtn;
    }

    // 10) BFS Hover Throbber
    function showThrobber(x, y) {
      if (!state.bfsThrobberElem) {
        const el = document.createElement('div');
        el.id = 'bfsHoverThrobber';
        el.addEventListener('animationend', onThrobberAnimationEnd);
        document.body.appendChild(el);
        state.bfsThrobberElem = el;
      }
      state.bfsThrobberElem.style.left = (x + 10) + 'px';
      state.bfsThrobberElem.style.top  = (y - 10) + 'px';
      state.bfsThrobberElem.style.setProperty('--bfsDebounceMs', state.bfsDebounceTime + 'ms');
      state.bfsThrobberElem.style.display = 'block';

      state.bfsThrobberElem.classList.remove('throbberActive');
      void state.bfsThrobberElem.offsetWidth;
      state.bfsThrobberElem.classList.add('throbberActive');
    }

    function hideThrobber() {
      if (state.bfsThrobberElem) {
        state.bfsThrobberElem.classList.remove('throbberActive');
        state.bfsThrobberElem.style.display = 'none';
      }
    }

    function onThrobberAnimationEnd(e) {
      if (e.target === state.bfsThrobberElem && state.hoveredDotIndex !== null) {
        runBFSHighlight(state.hoveredDotIndex);
      }
    }

    function runBFSHighlight(hoverIndex) {
      if (hoverIndex === null || hoverIndex !== state.hoveredDotIndex) return;
      const ds = state.chart?.data?.datasets[0];
      const forwardAdj = state.chart?.options?.plugins?.replyLinesPlugin?.forwardAdj;
      const reverseAdj = state.chart?.options?.plugins?.replyLinesPlugin?.reverseAdj;
      if (!ds || !forwardAdj || !reverseAdj) return;

      const newEdges = computeHighlightedEdges(hoverIndex, forwardAdj, reverseAdj);
      state.highlightEdges.clear();
      for (const e of newEdges) {
        state.highlightEdges.add(e);
      }
      if (state.chart) state.chart.render();
    }

    function cleanupHover() {
      if (state.hoverTimer) clearTimeout(state.hoverTimer);
      state.hoverTimer = null;

      if (state.throbberTimer) clearTimeout(state.throbberTimer);
      state.throbberTimer = null;

      hideThrobber();
      state.hoveredDotIndex = null;
    }

    // 11) Chart Plotting
    function plotGraph(graphData, replyStructures) {
      log(`Plotting chart for ${graphData.length} data points...`);

      const existingTopContainer = document.getElementById('threadActivityChartTopContainer');
      if (existingTopContainer) {
        existingTopContainer.remove();
      }
      const existingContainer = document.getElementById('threadActivityChartContainer');
      if (existingContainer) {
        existingContainer.remove();
      }

      let parentDiv = document.querySelector('div.adl');
      if (!parentDiv) {
        parentDiv = document.body;
      }

      const topContainer = document.createElement('div');
      topContainer.id = 'threadActivityChartTopContainer';
      topContainer.style.width = '100%';
      topContainer.style.marginBottom = '16px';
      parentDiv.insertBefore(topContainer, parentDiv.firstChild);

      const topBar = document.createElement('div');
      topBar.style.display      = 'flex';
      topBar.style.flexWrap     = 'wrap';
      topBar.style.alignItems   = 'center';
      topBar.style.marginBottom = '8px';
      topBar.style.gap          = '8px';

      const cogFrag = createCogMenu();
      const cogWrap = document.createElement('div');
      cogWrap.style.display = 'flex';
      cogWrap.appendChild(cogFrag);
      topBar.appendChild(cogWrap);

      const headerMiddle = document.createElement('div');
      headerMiddle.id = 'headerMiddleButtons';
      headerMiddle.style.flexGrow = '1';
      headerMiddle.style.display  = 'flex';
      headerMiddle.style.flexWrap = 'wrap';
      headerMiddle.style.gap      = '8px';
      topBar.appendChild(headerMiddle);

      const minBtn = createMinimizeButton();
      const minWrap = document.createElement('div');
      minWrap.style.display = 'flex';
      minWrap.style.marginLeft = 'auto';
      minWrap.appendChild(minBtn);
      topBar.appendChild(minWrap);

      topContainer.appendChild(topBar);

      const flagsBar = buildFlagsSummaryBar(graphData, state.uniqueUIDCount);
      if (flagsBar) {
        topContainer.appendChild(flagsBar);
      }

      const container = document.createElement('div');
      container.id = 'threadActivityChartContainer';
      container.style.width = '100%';
      container.style.height = '400px';
      container.style.backgroundColor = 'transparent';
      container.style.position = 'relative';
      topContainer.appendChild(container);

      {
        const { replyBgColor, textColor } = cachedColors;
        state.headerButtonsRefs.forEach(btn => {
          styleHeaderButton(btn, replyBgColor, textColor);
        });
      }

      const { replyCountMap, forwardAdj, reverseAdj } = replyStructures;

      state.chartConfig = {
        type: 'scatter',
        data: {
          datasets: [{
            label: 'Posts Over Time',
            data: graphData,
            showLine: false,
            pointRadius: (context) => {
              const idx = context.dataIndex;
              const d   = context.dataset.data[idx];
              if (!shouldHighlightFlag(d.flag)) return 0;
              const rCount = replyCountMap.get(d.number) || 0;
              const base   = 4;
              const maxExtra = 8;
              const normalSize = Math.min(base + rCount, base + maxExtra);

              if (state.hoveredFlagName && d.flag !== state.hoveredFlagName) {
                return 2;
              }
              if (state.hoveredIndex !== null && state.hoveredIndex !== idx && !state.hoveredFlagName) {
                return 2;
              }
              return normalSize;
            },
            pointHoverRadius: (ctx) => {
              const baseVal = ctx.dataset.pointRadius(ctx);
              return baseVal + 2;
            },
            pointBorderWidth: (ctx) => (state.useColoredBorders ? 2 : 1),
            pointHoverBorderWidth: (ctx) => (state.useColoredBorders ? 2 : 1),
            pointBackgroundColor: (ctx) => {
              const { replyBgColor } = cachedColors;
              const d = ctx.dataset.data[ctx.dataIndex];
              if (!shouldHighlightFlag(d.flag)) {
                return 'rgba(0,0,0,0)';
              }
              if (state.hoveredFlagName && d.flag !== state.hoveredFlagName) {
                return hexOrRgbaWithAlpha(replyBgColor, 0.4);
              }
              return replyBgColor;
            },
            pointBorderColor: (ctx) => {
              const { textColor } = cachedColors;
              const d = ctx.dataset.data[ctx.dataIndex];
              if (!shouldHighlightFlag(d.flag)) {
                return 'rgba(0,0,0,0)';
              }
              if (state.hoveredFlagName && d.flag !== state.hoveredFlagName) {
                return hexOrRgbaWithAlpha(
                  state.useColoredBorders
                    ? (state.uidColorMap.get(d.uid) || textColor)
                    : textColor,
                  0.4
                );
              }
              if (state.useColoredBorders && d.uid) {
                return state.uidColorMap.get(d.uid) || textColor;
              }
              return textColor;
            }
          }]
        },
        options: {
          responsive: false,
          maintainAspectRatio: false,
          animation: {
            duration: 0,
            animateScale: false,
            animateRotate: false
          },
          scales: {
            x: {
              type: 'time',
              time: {
                unit: 'minute',
                tooltipFormat: 'MMM d, HH:mm:ss'
              },
              title: {
                display: true,
                text: 'Time',
                color: cachedColors.textColor
              },
              ticks: {
                autoSkip: true,
                maxTicksLimit: 12,
                color: cachedColors.textColor
              },
              grid: {
                color: cachedColors.gridLineColor
              }
            },
            y: {
              type: 'linear',
              beginAtZero: true,
              title: {
                display: true,
                text: 'Post #',
                color: cachedColors.textColor
              },
              ticks: {
                autoSkip: true,
                maxTicksLimit: 12,
                color: cachedColors.textColor
              },
              grid: {
                color: cachedColors.gridLineColor
              }
            }
          },
          plugins: {
            legend: { display: false },
            replyLinesPlugin: {
              graphData,
              forwardAdj,
              reverseAdj,
              connectionColor: cachedColors.connectionColor,
              shouldHighlightFlagFn: shouldHighlightFlag,
              hoveredFlagName: state.hoveredFlagName,
              enableSingleFlagView: state.enableSingleFlagView,
              selectedSingleFlag: state.selectedSingleFlag,
              highlightEdges: state.highlightEdges,
              debugMode: state.debugMode
            },
            spamLabelPlugin: {
              spamDetected: state.spamDetected,
              isOnePbtidThread: state.isOnePbtidThread
            }
          },
          onHover: (event, elements) => handleHover(event, elements),
          onClick: (event, elements) => {
            if (elements.length > 0) {
              let clickIndex = elements[0].index;
              if (typeof clickIndex === 'undefined' && elements[0].element) {
                clickIndex = elements[0].element.$context.dataIndex;
              }
              const d = state.chart.data.datasets[0].data[clickIndex];
              window.location.href = `#p${d.number}`;
            }
          },
          hover: {
            mode: 'point',
            intersect: true,
            onHover: (e, elements) => {
              const cursorStyle = elements.length ? 'pointer' : 'default';
              if (e.native?.target) {
                e.native.target.style.cursor = cursorStyle;
              } else {
                e.target.style.cursor = cursorStyle;
              }
            }
          }
        }
      };

      const newCanvas = document.createElement('canvas');
      newCanvas.style.width  = '100%';
      newCanvas.style.height = '100%';
      container.appendChild(newCanvas);

      state.canvas = newCanvas;
      state.ctx    = newCanvas.getContext('2d');

      // Assign colors for each UID
      state.uidColorMap.clear();
      const uniqueUIDSet = new Set();
      graphData.forEach(p => {
        if (p.uid) {
          uniqueUIDSet.add(p.uid);
          if (!state.uidColorMap.has(p.uid)) {
            state.uidColorMap.set(p.uid, hashStringToColor(p.uid));
          }
        }
        if (p.number && p.rawHTML) {
          state.rawHTMLMap.set(p.number, p.rawHTML);
        }
      });
      state.uniqueUIDCount = uniqueUIDSet.size;
      updateIPCount(state.uniqueUIDCount);
      setup4chanXObserver();

      state.spamDetected = checkForSpamTrend(graphData);

      try {
        state.chart = createChartInstance(state.ctx, state.chartConfig);
        log('Chart created successfully!');
      } catch (err) {
        if (state.debugMode) console.error('Error creating Chart:', err);
      }

      injectForcedCSS(cachedColors.textColor, cachedColors.replyBgColor);
      const normalStroke = hexOrRgbaWithAlpha(cachedColors.connectionColor, 0.2);
      const highStroke   = hexOrRgbaWithAlpha(cachedColors.connectionColor, 1.0);
      insertToggleSwitchStyles(normalStroke, highStroke);
    }

    function handleHover(event, elements) {
      if (!elements || !elements.length) {
        if (state.hoveredDotIndex !== null) {
          cleanupHover();
          state.highlightEdges.clear();
          if (state.chart) state.chart.update();
        }
        return;
      }
      let hoverIndex = elements[0].index;
      if (typeof hoverIndex === 'undefined' && elements[0].element) {
        hoverIndex = elements[0].element.$context.dataIndex;
      }
      if (hoverIndex === state.hoveredDotIndex) {
        return;
      }
      cleanupHover();
      state.hoveredDotIndex = hoverIndex;

      state.throbberTimer = setTimeout(() => {
        if (state.hoveredDotIndex !== null && state.hoveredDotIndex === hoverIndex) {
          showThrobber(event.clientX, event.clientY);
        }
      }, 20);

      if (state.enableDotPreview && elements?.length) {
        showDotPreview(event, hoverIndex);
      }
    }

    function showDotPreview(event, hoverIndex) {
      const ds = state.chart?.data?.datasets[0];
      if (!ds) return;
      const d = ds.data[hoverIndex];
      if (!shouldHighlightFlag(d.flag)) {
        hidePreview();
        return;
      }
      let theRaw = d.rawHTML;
      if (!theRaw) {
        const stored = state.rawHTMLMap.get(d.number);
        if (stored) theRaw = stored;
      }
      if (!theRaw) theRaw = '(No post HTML)';

      const mouseX = (event.clientX ?? 0) + window.scrollX + 20;
      const mouseY = (event.clientY ?? 0) + window.scrollY - 20;
      showPreviewContent(theRaw, mouseX, mouseY);
    }

    function hidePreview() {
      if (state.hoverPreviewElem) {
        state.hoverPreviewElem.style.display = 'none';
        state.hoverPreviewElem.style.visibility = 'hidden';
      }
    }

    function showPreviewContent(htmlString, mouseX, mouseY) {
      if (!state.hoverPreviewElem) return;
      state.hoverPreviewElem.innerHTML = htmlString;
      state.hoverPreviewElem.style.display    = 'block';
      state.hoverPreviewElem.style.visibility = 'hidden';
      state.hoverPreviewElem.style.left       = '-9999px';
      state.hoverPreviewElem.style.top        = '-9999px';

      state.targetPreviewPosition.x = mouseX;
      state.targetPreviewPosition.y = mouseY;

      if (!state.pendingRaf) {
        state.pendingRaf = true;
        requestAnimationFrame(finalizePreviewPosition);
      }
    }

    function finalizePreviewPosition() {
      state.pendingRaf = false;
      if (!state.hoverPreviewElem) return;

      state.hoverPreviewElem.style.maxWidth  = 'calc(100vw - 40px)';
      state.hoverPreviewElem.style.maxHeight = 'calc(100vh - 80px)';

      const previewRect = state.hoverPreviewElem.getBoundingClientRect();
      let newLeft = state.targetPreviewPosition.x;
      let newTop  = state.targetPreviewPosition.y;
      const previewWidth  = previewRect.width;
      const previewHeight = previewRect.height;
      const winWidth  = window.innerWidth;
      const winHeight = window.innerHeight;

      if (newLeft + previewWidth > (winWidth + window.scrollX)) {
        newLeft = (winWidth + window.scrollX) - previewWidth - 8;
      }
      if (newTop + previewHeight > (winHeight + window.scrollY)) {
        newTop = (winHeight + window.scrollY) - previewHeight - 8;
      }
      if (newLeft < window.scrollX) {
        newLeft = window.scrollX + 2;
      }
      if (newTop < window.scrollY) {
        newTop = window.scrollY + 2;
      }

      state.hoverPreviewElem.style.left       = `${newLeft}px`;
      state.hoverPreviewElem.style.top        = `${newTop}px`;
      state.hoverPreviewElem.style.visibility = 'visible';
    }

    // 12) 1PBTID Check
    function checkIfOnePbtid(posts, threadID) {
      if (posts.length < 5) {
        return false;
      }
      const opPost = posts.find(p => p.number === threadID);
      if (!opPost || !opPost.uid) return false;
      const opUID = opPost.uid;
      const countForOp = posts.filter(p => p.uid === opUID).length;
      return (countForOp === 1);
    }

    // 13) Graph Data Generator
    function generateGraphData(posts) {
      return posts.map((p, i) => ({
        x: p.time,
        y: i + 1,
        number: p.number,
        replyTos: p.replyTos,
        uid: p.uid,
        flag: p.flag,
        flagHTML: p.flagHTML,
        messageHTML: p.messageHTML,
        rawHTML: p.rawHTML
      }));
    }

    // 14) Auto Update Logic
    function extractNewPostsFn() {
      const newPosts = extractNewPosts();
      if (newPosts.length === 0) {
        if (state.debugMode) log('autoUpdateThread: No new posts found.');
        return;
      }
      log(`New posts detected: ${newPosts.length}. Rebuilding chart...`);
      const allPosts = Array.from(state.postCache.values());
      const threadID = getThreadID();
      if (threadID) {
        state.isOnePbtidThread = checkIfOnePbtid(allPosts, threadID);
      }
      const newGraphData = generateGraphData(allPosts);
      const replyStructures = buildReplyStructures(newGraphData);
      plotGraph(newGraphData, replyStructures);
    }

    function setupAutoUpdate(intervalSecs = 15) {
      const initialPosts = extractPosts();
      initialPosts.forEach((p) => {
        if (!state.postCache.has(p.number)) {
          const container = document.getElementById(`p${p.number}`);
          if (container) {
            p.rawHTML = container.outerHTML;
          }
          state.postCache.set(p.number, p);
        }
      });
      setInterval(extractNewPostsFn, intervalSecs * 1000);
    }

    // 15) Main
    function main() {
      log('Script started. Checking thread...');
      initializeChartJSPlugins(state.debugMode);

      const threadID = getThreadID();
      if (!threadID) {
        log('No thread ID found. Exiting.');
        return;
      }
      log('Thread ID =', threadID);

      const rawPosts = extractPosts();
      if (!rawPosts || rawPosts.length === 0) {
        log('No valid posts extracted. Exiting script.');
        return;
      }
      log(`Extracted ${rawPosts.length} valid post(s).`);

      rawPosts.forEach((p) => {
        if (!p.rawHTML) {
          const container = document.getElementById(`p${p.number}`);
          if (container) {
            p.rawHTML = container.outerHTML;
          }
        }
        state.postCache.set(p.number, p);
      });

      state.isOnePbtidThread = checkIfOnePbtid(rawPosts, threadID);

      const graphData = generateGraphData(rawPosts);
      if (state.debugMode && graphData.length > 0) {
        console.log('Graph data sample:', graphData[0]);
      }
      const replyStructures = buildReplyStructures(graphData);

      getDynamicColors();
      const uniqueUIDSet = new Set(rawPosts.map(p => p.uid).filter(Boolean));
      state.uniqueUIDCount = uniqueUIDSet.size;

      state.hoverPreviewElem = createHoverPreviewElement();

      plotGraph(graphData, replyStructures);
      setupThemeObserver(() => {
        if (state.chart) {
          state.chart.options.scales.x.title.color = cachedColors.textColor;
          state.chart.options.scales.x.ticks.color = cachedColors.textColor;
          state.chart.options.scales.x.grid.color  = cachedColors.gridLineColor;
          state.chart.options.scales.y.title.color = cachedColors.textColor;
          state.chart.options.scales.y.ticks.color = cachedColors.textColor;
          state.chart.options.scales.y.grid.color  = cachedColors.gridLineColor;
          state.chart.options.plugins.replyLinesPlugin.connectionColor
            = cachedColors.connectionColor;
          state.chart.options.plugins.spamLabelPlugin.spamDetected
            = state.spamDetected;
          state.chart.options.plugins.spamLabelPlugin.isOnePbtidThread
            = state.isOnePbtidThread;
          state.chart.update();
        }
        const { replyBgColor, textColor, connectionColor } = cachedColors;
        if (state.cogButtonRef) {
          state.cogButtonRef.style.backgroundColor = replyBgColor;
          state.cogButtonRef.style.color           = textColor;
        }
        if (state.cogPanelRef) {
          state.cogPanelRef.style.backgroundColor  = replyBgColor;
          state.cogPanelRef.style.color            = textColor;
        }
        state.headerButtonsRefs.forEach(btn => {
          styleHeaderButton(btn, replyBgColor, textColor);
        });
        injectForcedCSS(textColor, replyBgColor);

        const normalStroke = hexOrRgbaWithAlpha(connectionColor, 0.2);
        const highStroke   = hexOrRgbaWithAlpha(connectionColor, 1.0);
        insertToggleSwitchStyles(normalStroke, highStroke);

        if (state.chart) {
          state.chart.update();
        }
      });

      setupAutoUpdate(15);
    }

    function createHoverPreviewElement() {
      const elem = document.createElement('div');
      elem.id = 'chartDotPreview';
      elem.style.position      = 'absolute';
      elem.style.zIndex        = '999999';
      elem.style.pointerEvents = 'none';
      elem.style.display       = 'none';
      elem.style.visibility    = 'hidden';
      elem.style.overflow      = 'auto';
      elem.style.left          = '-9999px';
      elem.style.top           = '-9999px';
      elem.style.maxWidth      = 'calc(100vw - 40px)';
      elem.style.maxHeight     = 'calc(100vh - 80px)';
      document.body.appendChild(elem);
      return elem;
    }

    main();
  })();

})();
