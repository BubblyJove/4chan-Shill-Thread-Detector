// ==UserScript==
// @name         4chan Thread Activity Grapher (Cubic Bezier + Dynamic Theme + Cog Menu + Flags + Persistence)
// @namespace    http://tampermonkey.net/
// @version      16.0
// @description  Activity graph with simpler chain detection, wave-like cubic Bézier lines, dynamic theme (auto-updating), fraction-based offset, advanced flags summary with images, reversed line hover, persistent toggles, dynamic Y-axis, spam detection
// @match        *://boards.4channel.org/*
// @match        *://boards.4chan.org/*
// @grant        none
// @run-at       document-idle
// @require      https://cdn.jsdelivr.net/npm/chart.js/dist/chart.umd.js
// @require      https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns/dist/chartjs-adapter-date-fns.bundle.min.js
// ==/UserScript==

(function() {
    'use strict';

    // ----------------------------------------------------------------
    //  0) Utility logger
    // ----------------------------------------------------------------
    function log(...args) {
        console.log('[4chan Grapher]:', ...args);
    }

    // ----------------------------------------------------------------
    //  Global variables to avoid reference errors
    // ----------------------------------------------------------------
    let chart = null;            // Chart instance
    let hoveredIndex = null;     // Which post is hovered
    let highlightSet = new Set();// Hover highlight references
    let uidColorMap = new Map(); // user ID -> color
    let themeChangeTimer = null; // for MutationObserver debounce
    let flagMap = new Map();     // flag -> count
    let uniqueUIDCount = 0;      // number of unique UIDs

    // We persist toggles (ID borders, show flags) in localStorage
    // default is false if not stored
    let useColoredBorders = (localStorage.getItem('useColoredBorders') === 'true');
    let showFlagsBar = (localStorage.getItem('showFlagsBar') === 'true');

    // For spam detection
    let spamDetected = false;  
    // New toggle to reduce false positives
    let spamDetectionEnabled = true; 

    // ----------------------------------------------------------------
    //  1) Thread & Post Extraction
    // ----------------------------------------------------------------
    function getThreadID() {
        try {
            const url = window.location.href;
            const match = url.match(/thread\/(\d+)/);
            return match ? match[1] : null;
        } catch (err) {
            log('Error in getThreadID:', err);
            return null;
        }
    }

    function getAllPostElements() {
        try {
            let all = document.querySelectorAll('.post');
            if (!all || all.length === 0) {
                all = document.querySelectorAll('.postContainer');
            }
            return Array.from(all);
        } catch (err) {
            log('Error in getAllPostElements:', err);
            return [];
        }
    }

    /**
     * Extract a single post’s metadata, including normal flags or .bfl memeflags.
     */
    function extractOnePost(postElem) {
        try {
            // 1) Post Number
            let postNumber = null;
            const postNumLink = postElem.querySelector('.postNum a');
            if (postNumLink) {
                const m = postNumLink.textContent.trim().match(/(\d+)/);
                if (m) postNumber = m[1];
            }
            if (!postNumber && postElem.id) {
                const idMatch = postElem.id.match(/^p(\d+)$/);
                if (idMatch) postNumber = idMatch[1];
            }
            if (!postNumber) return null;

            // 2) Time from [data-utc]
            let postTime = null;
            const dateElem = postElem.querySelector('[data-utc]');
            if (dateElem) {
                const utcVal = dateElem.getAttribute('data-utc');
                if (utcVal) {
                    postTime = new Date(parseInt(utcVal, 10) * 1000);
                }
            }
            if (!postTime) return null;

            // 3) Gather references
            const replyTos = [];
            const msgElem = postElem.querySelector('.postMessage');
            if (msgElem) {
                // a) direct text ">>123456"
                const textRefs = msgElem.innerText.match(/>>(\d+)/g);
                if (textRefs) {
                    textRefs.forEach(refStr => {
                        const digits = refStr.match(/\d+/);
                        if (digits) replyTos.push(digits[0]);
                    });
                }
                // b) anchor tags <a href="#p123456">
                const links = msgElem.querySelectorAll('a[href^="#p"]');
                links.forEach(a => {
                    const mm = a.getAttribute('href').match(/#p(\d+)/);
                    if (mm) replyTos.push(mm[1]);
                });
            }

            // 4) user ID
            let uid = null;
            const uidElem = postElem.querySelector('.posteruid');
            if (uidElem) {
                uid = uidElem.textContent.trim().replace(/ID:\s?/, '');
            }

            // 5) Flags
            // If .bfl => Memeflags, else normal .flag -> image src
            // We'll store actual "alt" text if normal, or "Memeflags" if bfl
            let flag = null;
            const polMemeFlagElem = postElem.querySelector('.bfl');
            if (polMemeFlagElem) {
                flag = 'Memeflags';
            } else {
                const normalFlagElem = postElem.querySelector('.flag[class*="flag-"]');
                if (normalFlagElem) {
                    const altOrTitle = normalFlagElem.alt || normalFlagElem.title;
                    if (altOrTitle && altOrTitle.trim() !== '') {
                        flag = altOrTitle.trim();
                    } else {
                        flag = 'Unknown';
                    }
                }
            }

            return {
                number: postNumber,
                time: postTime,
                replyTos,
                uid,
                flag,
                flagSrc: polMemeFlagElem ? null : getFlagSrc(postElem)
            };
        } catch (err) {
            log('Error in extractOnePost:', err);
            return null;
        }
    }

    /**
     * Attempt to get the actual flag image src, e.g. https://s.4cdn.org/image/country/ca.gif
     */
    function getFlagSrc(postElem) {
        const normalFlagElem = postElem.querySelector('.flag[class*="flag-"]');
        if (normalFlagElem && normalFlagElem.src) {
            return normalFlagElem.src;
        }
        return null;
    }

    function extractPosts() {
        const postElems = getAllPostElements();
        log(`Found ${postElems.length} post element(s).`);

        const results = [];
        postElems.forEach(pe => {
            const p = extractOnePost(pe);
            if (p) results.push(p);
        });
        return results;
    }

    function generateGraphData(posts) {
        return posts.map((p, i) => ({
            x: p.time,
            y: i + 1,
            number: p.number,
            replyTos: p.replyTos,
            uid: p.uid,
            flag: p.flag,
            flagSrc: p.flagSrc
        }));
    }

    // ----------------------------------------------------------------
    //  2) Prepare adjacency + reply counts
    // ----------------------------------------------------------------
    function buildReplyStructures(graphData) {
        const postIndexMap = new Map();
        const replyCountMap = new Map();
        const forwardAdj = new Map();
        const reverseAdj = new Map();

        graphData.forEach((pt, idx) => {
            replyCountMap.set(pt.number, 0);
            forwardAdj.set(idx, []);
            reverseAdj.set(idx, []);
        });

        // Build a map from postNumber->index
        graphData.forEach((pt, idx) => {
            postIndexMap.set(pt.number, idx);
        });

        // Fill adjacency
        graphData.forEach((point, idx) => {
            if (!point.replyTos) return;
            point.replyTos.forEach(refNum => {
                const targetIdx = postIndexMap.get(refNum);
                if (typeof targetIdx !== 'undefined') {
                    forwardAdj.get(idx).push(targetIdx);
                    reverseAdj.get(targetIdx).push(idx);
                    replyCountMap.set(refNum, (replyCountMap.get(refNum) || 0) + 1);
                }
            });
        });

        return {
            postIndexMap,
            replyCountMap,
            forwardAdj,
            reverseAdj
        };
    }

    // ----------------------------------------------------------------
    //  3) ID -> Color map
    // ----------------------------------------------------------------
    function hashStringToColor(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
            hash |= 0; // convert to 32bit integer
        }
        const hue = Math.abs(hash) % 360;
        return `hsl(${hue},70%,50%)`;
    }

    // ----------------------------------------------------------------
    //  4) Dynamic Bezier Control Points (wave)
    // ----------------------------------------------------------------
    const bezierMap = new Map();
    function getCubicBezierControls(idxA, idxB, x1, y1, x2, y2, segmentOrder = 0) {
        try {
            const key = (idxA < idxB)
                ? `${idxA}-${idxB}-${segmentOrder}`
                : `${idxB}-${idxA}-${segmentOrder}`;
            if (bezierMap.has(key)) {
                return bezierMap.get(key);
            }

            const dx = x2 - x1;
            const dy = y2 - y1;
            const dist = Math.sqrt(dx * dx + dy * dy);

            let offset = 0.2 * dist;
            offset = Math.min(offset, 60);

            const sign = (segmentOrder % 2 === 0) ? 1 : -1;
            const cx1 = x1 + dx / 3;
            const cy1 = y1 + dy / 3 + sign * offset;
            const cx2 = x1 + 2 * dx / 3;
            const cy2 = y1 + 2 * dy / 3 - sign * offset;

            const controls = { cx1, cy1, cx2, cy2 };
            bezierMap.set(key, controls);
            return controls;
        } catch (err) {
            log('Error in getCubicBezierControls:', err);
            return { cx1: x1, cy1: y1, cx2: x2, cy2: y2 };
        }
    }

    // ----------------------------------------------------------------
    //  5) Dynamic Colors + Observer
    // ----------------------------------------------------------------
    let cachedColors = {
        textColor: '#fff',
        gridLineColor: 'rgba(128,128,128,0.1)',
        connectionColor: 'rgba(30,144,255,1)',
        replyBgColor: '#ccc'
    };

    function getDynamicColors() {
        try {
            // textColor
            let textColor = cachedColors.textColor;
            const postMsg = document.querySelector('.postMessage');
            if (postMsg) {
                const c = window.getComputedStyle(postMsg).color;
                if (c) textColor = c;
            } else {
                const c = window.getComputedStyle(document.body).color;
                if (c) textColor = c;
            }

            // gridLineColor
            let gridLineColor = cachedColors.gridLineColor;
            const hr = document.querySelector('hr');
            if (hr) {
                const hrStyle = window.getComputedStyle(hr);
                if (hrStyle.borderTopColor) gridLineColor = hrStyle.borderTopColor;
            }

            // connectionColor
            let connectionColor = cachedColors.connectionColor;
            const backlink = document.querySelector('a.backlink');
            if (backlink) {
                const bstyle = window.getComputedStyle(backlink).color;
                if (bstyle) connectionColor = bstyle;
            }

            // replyBgColor
            let replyBgColor = cachedColors.replyBgColor;
            const replyDiv = document.querySelector('.reply');
            if (replyDiv) {
                const repStyle = window.getComputedStyle(replyDiv).backgroundColor;
                if (repStyle) replyBgColor = repStyle;
            }

            // update cache
            cachedColors = {
                textColor,
                gridLineColor,
                connectionColor,
                replyBgColor
            };
        } catch (err) {
            log('Error in getDynamicColors:', err);
        }
    }

    function setupThemeObserver(onThemeChanged) {
        try {
            const body = document.body;
            if (!body) return;

            const observer = new MutationObserver(() => {
                if (themeChangeTimer) {
                    clearTimeout(themeChangeTimer);
                }
                themeChangeTimer = setTimeout(() => {
                    getDynamicColors();
                    onThemeChanged();
                }, 300);
            });

            observer.observe(body, {
                attributes: true,
                childList: true,
                subtree: true
            });
        } catch (err) {
            log('Error in setupThemeObserver:', err);
        }
    }

    // ----------------------------------------------------------------
    //  6) Quick correlation check for spam detection
    // ----------------------------------------------------------------
    function checkForSpamTrend(graphData) {
        // We'll do a simple correlation between post index (1..N) and time
        // If the correlation >= 0.99 => spamDetected = true
        // x = time in minutes from first post
        // y = index
        if (!spamDetectionEnabled) {
            return false;
        }
        if (graphData.length < 5) {
            // not enough data to detect
            return false;
        }
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
        // basic correlation formula
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

    // ----------------------------------------------------------------
    //  7) Simple chain-building
    // ----------------------------------------------------------------
    function buildReplyChains(graphData, forwardAdj) {
        try {
            const chains = [];
            for (let i = 0; i < graphData.length; i++) {
                const nextNodes = forwardAdj.get(i);
                if (!nextNodes || nextNodes.length === 0) continue;

                nextNodes.forEach((nextIdx, indexAmongSiblings) => {
                    const chain = [i];
                    let current = nextIdx;
                    while (true) {
                        chain.push(current);
                        const nextList = forwardAdj.get(current) || [];
                        if (nextList.length === 1) {
                            current = nextList[0];
                            if (chain.includes(current)) {
                                break;
                            }
                        } else {
                            break;
                        }
                    }
                    chains.push(chain);
                });
            }
            return chains;
        } catch (err) {
            log('Error in buildReplyChains:', err);
            return [];
        }
    }

    // ----------------------------------------------------------------
    //  8) The Lines Plugin (two-pass draw: normal ~0.2 alpha, highlight 1.0 alpha)
    // ----------------------------------------------------------------
    const replyLinesPlugin = {
        id: 'replyLinesPlugin',
        beforeDatasetsDraw(chart, args, pluginOptions) {
            try {
                const {
                    graphData,
                    forwardAdj,
                    reverseAdj,
                    connectionColor,
                    chains
                } = pluginOptions || {};
                if (!graphData || graphData.length === 0) return;

                const { ctx, scales } = chart;
                ctx.save();

                // Precompute pixel coords
                const xCoords = new Array(graphData.length);
                const yCoords = new Array(graphData.length);
                for (let i = 0; i < graphData.length; i++) {
                    const d = graphData[i];
                    xCoords[i] = scales.x.getPixelForValue(d.x);
                    yCoords[i] = scales.y.getPixelForValue(d.y);
                }

                // default: 0.2 alpha; highlight: 1.0 alpha
                const normalStroke = hexOrRgbaWithAlpha(connectionColor, 0.2);
                const highStroke   = hexOrRgbaWithAlpha(connectionColor, 1.0);

                ctx.lineWidth = 1;

                // which chains are hovered
                const highlightChainSet = new Set();
                if (hoveredIndex !== null) {
                    chains.forEach(chain => {
                        if (chain.some(idx => highlightSet.has(idx))) {
                            highlightChainSet.add(chain);
                        }
                    });
                }

                // 1) Draw all lines at normal alpha
                chains.forEach(chain => {
                    ctx.beginPath();
                    ctx.strokeStyle = normalStroke;

                    const firstIdx = chain[0];
                    ctx.moveTo(xCoords[firstIdx], yCoords[firstIdx]);
                    for (let c = 1; c < chain.length; c++) {
                        const idxA = chain[c - 1];
                        const idxB = chain[c];
                        const { cx1, cy1, cx2, cy2 } = getCubicBezierControls(
                            idxA, idxB,
                            xCoords[idxA], yCoords[idxA],
                            xCoords[idxB], yCoords[idxB],
                            c - 1
                        );
                        ctx.bezierCurveTo(cx1, cy1, cx2, cy2, xCoords[idxB], yCoords[idxB]);
                    }
                    ctx.stroke();
                });

                // 2) Overdraw highlight chains at full alpha
                highlightChainSet.forEach(chain => {
                    ctx.beginPath();
                    ctx.strokeStyle = highStroke;

                    const firstIdx = chain[0];
                    ctx.moveTo(xCoords[firstIdx], yCoords[firstIdx]);
                    for (let c = 1; c < chain.length; c++) {
                        const idxA = chain[c - 1];
                        const idxB = chain[c];
                        const { cx1, cy1, cx2, cy2 } = getCubicBezierControls(
                            idxA, idxB,
                            xCoords[idxA], yCoords[idxA],
                            xCoords[idxB], yCoords[idxB],
                            c - 1
                        );
                        ctx.bezierCurveTo(cx1, cy1, cx2, cy2, xCoords[idxB], yCoords[idxB]);
                    }
                    ctx.stroke();
                });

                ctx.restore();
            } catch (err) {
                log('Error in replyLinesPlugin beforeDatasetsDraw:', err);
            }
        }
    };

    try {
        if (typeof Chart !== 'undefined') {
            Chart.register(replyLinesPlugin);
        } else {
            log('Chart.js not found. Please ensure @require is correct.');
        }
    } catch (err) {
        log('Error registering plugin:', err);
    }

    // ----------------------------------------------------------------
    //  9) Helper to convert color with alpha
    // ----------------------------------------------------------------
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
                return baseColor.replace(/hsla?\(/, 'hsla(').replace(/\)$/, `, ${alpha})`);
            }
            return `rgba(0, 0, 0, ${alpha})`;
        } catch (err) {
            log('Error in hexOrRgbaWithAlpha:', err);
            return `rgba(0, 0, 0, ${alpha})`;
        }
    }

    // ----------------------------------------------------------------
    // 10) Chart Rendering + Flags Bar + Cog Menu + IP injection + Spam detect
    // ----------------------------------------------------------------

    /**
     * Build a flags summary bar.
     * We display normal flags (with their images) in alphabetical order,
     * then "Memeflags" at the end with no image.
     */
    function buildFlagsSummaryBar(graphData, uniqueUIDCount) {
        flagMap.clear();
        // We'll separate memeflags from normal
        const memeflagsCount = { Memeflags: 0 };

        graphData.forEach(p => {
            if (p.flag) {
                if (p.flag === 'Memeflags') {
                    memeflagsCount.Memeflags++;
                } else {
                    const f = p.flag.trim();
                    if (!flagMap.has(f)) {
                        flagMap.set(f, { count: 0, src: p.flagSrc || null });
                    }
                    flagMap.get(f).count++;
                }
            }
        });

        // If no flags at all
        if (flagMap.size === 0 && memeflagsCount.Memeflags === 0) {
            return null;
        }

        // Build the bar
        const bar = document.createElement('div');
        bar.id = 'flagsSummaryBar';
        bar.style.display = showFlagsBar ? 'block' : 'none';
        bar.style.marginBottom = '8px';
        bar.style.padding = '4px';

        // 1) Normal flags sorted by name
        const sortedFlags = [...flagMap.keys()].sort();
        sortedFlags.forEach(flagName => {
            const info = flagMap.get(flagName);
            const count = info.count;
            const src = info.src;

            // container for each flag
            const span = document.createElement('span');
            span.style.marginRight = '12px';

            if (src) {
                // show image
                const img = document.createElement('img');
                img.src = src;
                img.width = 16;
                img.height = 12;
                img.style.marginRight = '4px';
                span.appendChild(img);
            }
            // text like "Canada (5)"
            span.appendChild(document.createTextNode(`${flagName} (${count})`));
            bar.appendChild(span);
        });

        // 2) Memeflags at the end, if any
        if (memeflagsCount.Memeflags > 0) {
            const memefSpan = document.createElement('span');
            memefSpan.style.marginRight = '12px';
            memefSpan.textContent = `Memeflags (${memeflagsCount.Memeflags})`;
            bar.appendChild(memefSpan);
        }

        // 3) Fallback: also display the number of UIDs
        if (uniqueUIDCount > 0) {
            const idSpan = document.createElement('span');
            idSpan.style.marginRight = '12px';
            idSpan.textContent = `UIDs: ${uniqueUIDCount}`;
            bar.appendChild(idSpan);
        }

        return bar;
    }

    /**
     * Insert or update IP count with our uniqueUIDCount.
     * For 4chanX, we might see #ip-count, for vanilla we might see .ts-ip-count or none.
     * We'll just replace that if found. Otherwise do fallback creation.
     */
    function updateIPCount(uniqueUIDCount) {
        // 1) 4chanX approach (#ip-count)
        const ipCountSpanX = document.querySelector('span#ip-count');
        if (ipCountSpanX) {
            // Overwrite text with just the number
            ipCountSpanX.textContent = `${uniqueUIDCount}`;
            return;
        }

        // 2) Maybe a .ts-ip-count in vanilla
        const ipCountTs = document.querySelector('.ts-ip-count');
        if (ipCountTs) {
            ipCountTs.textContent = `${uniqueUIDCount}`;
            return;
        }

        // 3) fallback: create a new element and place it somewhere near the top
        // We'll try some typical containers
        const fallbackContainer = document.querySelector('#header, #threads, .boardTitle, body');
        if (fallbackContainer) {
            const newSpan = document.createElement('span');
            newSpan.id = 'ip-count';
            newSpan.style.marginLeft = '8px';
            newSpan.textContent = `IDs: ${uniqueUIDCount}`;
            fallbackContainer.appendChild(newSpan);
        }
    }

    // We'll store references to check spam label
    let spamLabelElem = null;

    /**
     * Creates the cog menu. Also positions the spam label to the right of the cog.
     */
    function createCogMenu(parent) {
        // We'll put the cog inside the chart container (top-left)
        const cogContainer = document.createElement('div');
        cogContainer.id = 'cogMenuContainer';
        cogContainer.style.position = 'absolute';
        // Increase left padding here
        cogContainer.style.left = '60px';  // <--- Adjusted for extra left padding
        cogContainer.style.top = '10px';
        cogContainer.style.zIndex = '9999';
        cogContainer.style.cursor = 'pointer';
        cogContainer.style.fontSize = '14px';
        cogContainer.style.display = 'flex';
        cogContainer.style.alignItems = 'center';

        // the cog itself
        const cogButton = document.createElement('div');
        cogButton.textContent = '⚙';
        cogButton.style.fontSize = '18px';
        cogButton.style.padding = '5px 10px';
        cogButton.style.border = '1px solid #ccc';
        cogButton.style.borderRadius = '4px';
        cogButton.style.textAlign = 'center';
        cogButton.style.display = 'inline-block';

        // the panel
        const panel = document.createElement('div');
        panel.style.display = 'none';
        panel.style.flexDirection = 'column';
        panel.style.position = 'absolute';
        panel.style.top = '40px';
        panel.style.left = '0';
        panel.style.padding = '10px';
        panel.style.border = '1px solid #ccc';
        panel.style.borderRadius = '4px';
        panel.style.minWidth = '140px';

        // We'll match the dot background + text color
        const { replyBgColor, textColor } = cachedColors;
        panel.style.backgroundColor = replyBgColor;
        panel.style.color = textColor;
        cogButton.style.backgroundColor = replyBgColor;
        cogButton.style.color = textColor;

        // We'll have toggles: ID borders, Flags, Spam detection
        const idBorderLabel = document.createElement('label');
        idBorderLabel.style.display = 'block';
        idBorderLabel.style.marginBottom = '6px';
        const idBorderCheckbox = document.createElement('input');
        idBorderCheckbox.type = 'checkbox';
        idBorderCheckbox.checked = useColoredBorders;
        idBorderLabel.appendChild(idBorderCheckbox);
        idBorderLabel.appendChild(document.createTextNode('ID Borders'));

        idBorderCheckbox.addEventListener('change', () => {
            useColoredBorders = idBorderCheckbox.checked;
            localStorage.setItem('useColoredBorders', String(useColoredBorders));
            if (chart) {
                chart.update();
            }
        });

        const flagsLabel = document.createElement('label');
        flagsLabel.style.display = 'block';
        flagsLabel.style.marginBottom = '6px';
        const flagsCheckbox = document.createElement('input');
        flagsCheckbox.type = 'checkbox';
        flagsCheckbox.checked = showFlagsBar;
        flagsLabel.appendChild(flagsCheckbox);
        flagsLabel.appendChild(document.createTextNode('Show Flags'));

        flagsCheckbox.addEventListener('change', () => {
            showFlagsBar = flagsCheckbox.checked;
            localStorage.setItem('showFlagsBar', String(showFlagsBar));
            const bar = document.getElementById('flagsSummaryBar');
            if (bar) {
                bar.style.display = showFlagsBar ? 'block' : 'none';
            }
        });

        const spamDetectLabel = document.createElement('label');
        spamDetectLabel.style.display = 'block';
        spamDetectLabel.style.marginBottom = '6px';
        const spamDetectCheckbox = document.createElement('input');
        spamDetectCheckbox.type = 'checkbox';
        spamDetectCheckbox.checked = spamDetectionEnabled;
        spamDetectLabel.appendChild(spamDetectCheckbox);
        spamDetectLabel.appendChild(document.createTextNode('Enable Spam Detection'));

        spamDetectCheckbox.addEventListener('change', () => {
            spamDetectionEnabled = spamDetectCheckbox.checked;
            // re-check spam if toggled
            if (spamDetectionEnabled && chart && chart.data && chart.data.datasets[0]) {
                const data = chart.data.datasets[0].data;
                spamDetected = checkForSpamTrend(data);
            } else {
                spamDetected = false;
            }
            updateSpamLabel();
        });

        panel.appendChild(idBorderLabel);
        panel.appendChild(flagsLabel);
        panel.appendChild(spamDetectLabel);

        // Show/hide panel on cog click
        cogButton.addEventListener('click', () => {
            panel.style.display = (panel.style.display === 'none') ? 'flex' : 'none';
        });

        // the spam label (to the right of the cog)
        spamLabelElem = document.createElement('div');
        spamLabelElem.id = 'spamLabelElem';
        spamLabelElem.style.fontWeight = 'bold';
        spamLabelElem.style.marginLeft = '12px';
        spamLabelElem.style.minWidth = '80px';

        // Add cog + spam label to container
        cogContainer.appendChild(cogButton);
        cogContainer.appendChild(spamLabelElem);

        // Add panel
        cogContainer.appendChild(panel);

        parent.appendChild(cogContainer);

        return { spamLabelElem, cogButton, panel, idBorderCheckbox, flagsCheckbox };
    }

    /**
     * Creates a small minimize button on the top-right of the container
     * that toggles the chart's visibility.
     */
    function createMinimizeButton(parent) {
        const minBtn = document.createElement('div');
        minBtn.id = 'minimizeButton';
        minBtn.style.position = 'absolute';
        minBtn.style.top = '10px';
        // Increase right padding here
        minBtn.style.right = '20px';  // <--- Adjusted for extra right padding
        minBtn.style.zIndex = '9999';
        minBtn.style.cursor = 'pointer';
        minBtn.style.fontSize = '14px';
        minBtn.style.padding = '3px 6px';
        minBtn.style.border = '1px solid #ccc';
        minBtn.style.borderRadius = '4px';
        minBtn.style.backgroundColor = '#eee';
        minBtn.textContent = '-';

        let isMinimized = false;
        minBtn.addEventListener('click', () => {
            isMinimized = !isMinimized;
            if (isMinimized) {
                parent.style.height = '40px';
                const canvas = parent.querySelector('canvas');
                if (canvas) canvas.style.display = 'none';
                minBtn.textContent = '+';
            } else {
                parent.style.height = '400px';
                const canvas = parent.querySelector('canvas');
                if (canvas) canvas.style.display = 'block';
                minBtn.textContent = '-';
            }
        });
        parent.appendChild(minBtn);
    }

    function updateSpamLabel() {
        if (!spamLabelElem) return;
        if (spamDetected) {
            spamLabelElem.textContent = 'Spam detected';
        } else {
            spamLabelElem.textContent = '';
        }
    }

    function plotGraph(graphData, replyStructures, flagsBar) {
        log(`Plotting chart for ${graphData.length} data points...`);

        // Attempt to place the container in div.adl
        let parentDiv = document.querySelector('div.adl');
        if (!parentDiv) {
            parentDiv = document.body; // fallback
        }

        // Container
        const container = document.createElement('div');
        container.id = 'threadActivityChartContainer';
        Object.assign(container.style, {
            width: '100%',
            height: '400px',
            marginBottom: '16px',
            backgroundColor: 'transparent',
            position: 'relative'
        });

        // Insert the container (and optional flags bar) into the parentDiv
        if (flagsBar) {
            parentDiv.insertBefore(flagsBar, parentDiv.firstChild);
            parentDiv.insertBefore(container, parentDiv.firstChild);
        } else {
            parentDiv.insertBefore(container, parentDiv.firstChild);
        }

        const { replyCountMap, forwardAdj, reverseAdj } = replyStructures;
        const { textColor, gridLineColor, connectionColor, replyBgColor } = cachedColors;

        // Create the new cog menu (top-left) inside the chart container
        createCogMenu(container);

        // Create the minimize button (top-right)
        createMinimizeButton(container);

        // Canvas
        const canvas = document.createElement('canvas');
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        container.appendChild(canvas);

        const ctx = canvas.getContext('2d');

        // Build chain segments
        let chains = [];
        try {
            chains = buildReplyChains(graphData, forwardAdj);
        } catch (err) {
            log('Error building chains:', err);
        }

        // build a fresh map of UIDs -> color
        uidColorMap.clear();
        const uniqueUIDSet = new Set();
        graphData.forEach(p => {
            if (p.uid) {
                uniqueUIDSet.add(p.uid);
                if (!uidColorMap.has(p.uid)) {
                    uidColorMap.set(p.uid, hashStringToColor(p.uid));
                }
            }
        });
        uniqueUIDCount = uniqueUIDSet.size;

        // Insert/update IP count
        updateIPCount(uniqueUIDCount);

        // We'll do a quick spam check (only if spamDetectionEnabled)
        spamDetected = spamDetectionEnabled && checkForSpamTrend(graphData);
        updateSpamLabel();

        // Attempt to create Chart
        try {
            chart = new Chart(ctx, {
                type: 'scatter',
                data: {
                    datasets: [{
                        label: 'Posts Over Time',
                        data: graphData,
                        showLine: false,
                        pointRadius: (ctx) => {
                            const idx = ctx.dataIndex;
                            const d = ctx.dataset.data[idx];
                            const rCount = replyCountMap.get(d.number) || 0;
                            // scale from 4..12
                            const base = 4;
                            const maxExtra = 8;
                            return Math.min(base + rCount, base + maxExtra);
                        },
                        // Post dots match .reply background color
                        pointBackgroundColor: replyBgColor,
                        // Outline color defaults to textColor if not using ID borders
                        pointBorderColor: (ctx) => {
                            const idx = ctx.dataIndex;
                            const d = ctx.dataset.data[idx];
                            if (useColoredBorders && d.uid) {
                                return uidColorMap.get(d.uid) || textColor;
                            }
                            return textColor;
                        },
                        pointBorderWidth: (ctx) => {
                            return useColoredBorders ? 2 : 1;
                        }
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    // *** We do a dynamic Y axis: type 'linear'
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
                                color: textColor
                            },
                            ticks: {
                                autoSkip: true,
                                maxTicksLimit: 12,
                                color: textColor
                            },
                            grid: {
                                color: gridLineColor
                            }
                        },
                        y: {
                            type: 'linear', // dynamic numeric axis
                            beginAtZero: true,
                            title: {
                                display: true,
                                text: 'Post #',
                                color: textColor
                            },
                            ticks: {
                                autoSkip: true,
                                maxTicksLimit: 12,
                                color: textColor
                            },
                            grid: {
                                color: gridLineColor
                            }
                        }
                    },
                    plugins: {
                        legend: { display: false },
                        // pass chains to the plugin
                        replyLinesPlugin: {
                            graphData,
                            forwardAdj,
                            reverseAdj,
                            connectionColor,
                            chains
                        }
                    },
                    interaction: {
                        mode: 'point',
                        intersect: true
                    },
                    events: ['mousemove', 'mouseout', 'click', 'touchstart', 'touchmove'],
                    onClick: (event, elements) => {
                        // When you click a post dot, jump to that post
                        if (elements.length > 0) {
                            const index = elements[0].index;
                            const d = chart.data.datasets[0].data[index];
                            // Set window hash so it jumps to #p123456
                            window.location.href = `#p${d.number}`;
                        }
                    },
                    onHover: (event, chartElements) => {
                        if (chartElements.length > 0) {
                            const elem = chartElements[0];
                            hoveredIndex = elem.index;
                            highlightSet = new Set([hoveredIndex]);
                            forwardAdj.get(hoveredIndex).forEach(c => highlightSet.add(c));
                            reverseAdj.get(hoveredIndex).forEach(p => highlightSet.add(p));
                        } else {
                            hoveredIndex = null;
                            highlightSet.clear();
                        }
                        if (chart) chart.update();
                    },
                    hover: {
                        onHover: (event, elements) => {
                            event.native.target.style.cursor = elements.length ? 'pointer' : 'default';
                        }
                    }
                }
            });
            log('Chart created successfully!');
        } catch (err) {
            log('Error creating Chart:', err);
        }
    }

    // ----------------------------------------------------------------
    //  11) Main
    // ----------------------------------------------------------------
    function main() {
        try {
            log('Script started. Checking thread...');
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

            const graphData = generateGraphData(rawPosts);
            log('Graph data sample:', graphData[0] || '(empty)');

            // Build adjacency
            const replyStructures = buildReplyStructures(graphData);

            // Acquire initial dynamic colors
            getDynamicColors();

            // Build optional flags bar (pass uniqueUIDCount=0 initially; we fix it later)
            // Actually, we won't know the final uniqueUIDCount until we parse them below,
            // but let's do a two-pass approach. We'll set it after counting.
            // However, we do want the final uniqueUIDCount in the bar, so we handle it after we parse UIDs in plotGraph.
            // We'll do it all in the same pass for cleanliness, so let's do a quick pre-check:
            const uniqueUIDSet = new Set(rawPosts.map(p => p.uid).filter(Boolean));
            uniqueUIDCount = uniqueUIDSet.size;

            const flagsBar = buildFlagsSummaryBar(graphData, uniqueUIDCount);

            // Plot
            plotGraph(graphData, replyStructures, flagsBar);

            // Setup observer to auto-update if theme changes
            setupThemeObserver(() => {
                if (chart) {
                    const { textColor, gridLineColor, connectionColor, replyBgColor } = cachedColors;
                    // Update axis color
                    chart.options.scales.x.title.color = textColor;
                    chart.options.scales.x.ticks.color = textColor;
                    chart.options.scales.x.grid.color = gridLineColor;
                    chart.options.scales.y.title.color = textColor;
                    chart.options.scales.y.ticks.color = textColor;
                    chart.options.scales.y.grid.color = gridLineColor;
                    // Update lines plugin color
                    chart.options.plugins.replyLinesPlugin.connectionColor = connectionColor;
                    // Update the dot background color
                    chart.data.datasets[0].pointBackgroundColor = replyBgColor;

                    // Also update default border color
                    chart.data.datasets[0].pointBorderColor = (ctx) => {
                        const idx = ctx.dataIndex;
                        const d = ctx.dataset.data[idx];
                        if (useColoredBorders && d.uid) {
                            return uidColorMap.get(d.uid) || textColor;
                        }
                        return textColor;
                    };

                    // update cog + panel background + text
                    const cogMenu = document.getElementById('cogMenuContainer');
                    if (cogMenu) {
                        cogMenu.querySelectorAll('div, label').forEach(el => {
                            el.style.backgroundColor = replyBgColor;
                            el.style.color = textColor;
                        });
                    }
                    chart.update();
                }
            });

            log('Done with main().');
        } catch (err) {
            log('Critical error in main():', err);
        }
    }

    // Run after document idle
    setTimeout(main, 1000);
})();
