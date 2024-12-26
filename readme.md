# 4chan Spam Thread Detector

A handy userscript that draws a timeline of post activity on 4chan threads with smooth, wave-like reply connections. It adapts to your chosen theme, displays flags, detects possible spam, and lets you toggle settings right on the chart.

---

## What It Does (Quick Overview)

- **Thread Activity Chart:** Each post is shown as a dot on a time-based axis, so you can see how quickly the thread grows.  
- **Wavy Reply Lines:** Replies between posts are linked with gentle cubic Bézier curves, making the conversation flow visually.  
- **Flags Summary Bar:** Shows all country flags (and “memeflags”) used in the thread, so you can get a quick overview of everyone posting.  
- **User ID Coloring:** You can turn on colored borders for posts based on user IDs, which helps track conversations from the same user.  
- **Dynamic Theme Detection:** The graph automatically updates its colors if you switch to a different theme or userstyle.  
- **Spam Detection:** Checks if posts are being made in a suspiciously linear pattern (like a spam/shill thread), and if so, shows a **Spam detected** alert.  
- **Cog Menu & Persistence:** A small gear icon on the chart lets you turn certain features on/off, and your choices are remembered the next time you load a thread.

---

## How to Use It

1. **Install a Userscript Manager:**  
   - Tampermonkey is recommended.  

2. **Install This Script:**  
   - Grab it from GitHub or Greasy Fork.  

3. **Open Any 4chan Thread:**  
   - Give it a second to gather post data. The chart and optional flags bar will appear at the top of the page.  

4. **Hover Over Chart Dots:**  
   - When you mouse over a point, its replies and parents highlight in a brighter color so you can follow the conversation chain.  

5. **Use the Gear (⚙) Menu:**  
   - Found in the top-left corner of the chart. Click it to toggle the flags bar or user ID borders.  

6. **Check for Spam:**  
   - If the script thinks the post pattern looks botted, you’ll see “Spam detected” next to the gear icon.  

---

## Behind the Scenes (For Programmers)

- **Post Parsing:**  
  - Scans `.post` (or `.postContainer`) elements to extract the post ID, timestamp (`data-utc`), user ID (`.posteruid`), flags (regular or `.bfl` memeflags), and references (`>>123456`, `<a href="#p123456">`).
  - Creates an array of data points for each post, storing both its time (for the X axis) and index (for the Y axis).

- **Chart.js + Date-FNS:**  
  - Renders a scatter plot with a time-based X axis and a numerical Y axis (1 through N for each post).
  - A custom plugin (`replyLinesPlugin`) draws wave-like cubic Bézier curves between related posts.

- **Reply Chains:**  
  - The script builds adjacency lists to figure out reply relationships, then forms simple chains. These chains are rendered as continuous Bézier paths on the chart.

- **Dynamic Theming:**  
  - A `MutationObserver` looks for style changes. If you switch to a different theme or userstyle, it re-queries the current text color, background color, etc., and updates the chart accordingly.

- **Local Storage Settings:**  
  - The toggles for showing the flags bar or using colored ID borders are saved, so your preferences persist across page loads.

- **Spam Detection:**  
  - Uses a quick Pearson correlation between time (minutes since first post) and post index. If the correlation is too high (≥ 0.95), it flags the thread as spammy.

---

## Contributing & Customization

Feel free to fork or contribute if you’d like to tweak how the waves look, adjust spam thresholds, or add more features. Opening a pull request or an issue on GitHub is the best way to share updates or report bugs.

Enjoy exploring your threads with this interactive chart!
