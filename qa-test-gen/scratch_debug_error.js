import { chromium } from 'playwright';

// User's provided cookies
const cookies = [
    {
        "domain": ".practiceplan.co.uk",
        "expirationDate": 1818050278.048504,
        "hostOnly": false,
        "httpOnly": false,
        "name": "_ga",
        "path": "/",
        "sameSite": "unspecified",
        "secure": false,
        "session": false,
        "storeId": "0",
        "value": "GA1.1.1956963475.1783490278",
        "id": 1
    },
    {
        "domain": ".practiceplan.co.uk",
        "expirationDate": 1818480734.114728,
        "hostOnly": false,
        "httpOnly": false,
        "name": "_ga_5M3DXLYPLW",
        "path": "/",
        "sameSite": "unspecified",
        "secure": false,
        "session": false,
        "storeId": "0",
        "value": "GS2.1.s1783920685$o8$g1$t1783920734$j11$l0$h22595536",
        "id": 2
    },
    {
        "domain": ".practiceplan.co.uk",
        "expirationDate": 1783922633,
        "hostOnly": false,
        "httpOnly": false,
        "name": "_hjSession_3395087",
        "path": "/",
        "sameSite": "no_restriction",
        "secure": true,
        "session": false,
        "storeId": "0",
        "value": "eyJpZCI6IjBiOWY3OThmLTYzOWUtNDQzZS04MDlhLWQyNDBjOGEyOGI5MiIsImMiOjE3ODM5MjA2ODU0MzEsInMiOjEsInIiOjAsInNiIjowLCJzciI6MCwic2UiOjAsImZzIjowfQ==",
        "id": 3
    },
    {
        "domain": ".practiceplan.co.uk",
        "expirationDate": 1815456685,
        "hostOnly": false,
        "httpOnly": false,
        "name": "_hjSessionUser_3395087",
        "path": "/",
        "sameSite": "no_restriction",
        "secure": true,
        "session": false,
        "storeId": "0",
        "value": "eyJpZCI6ImIzNDUxNTE4LTY1Y2ItNTQ5OS1hMDcwLTE0MDMzY2MzNDM2NCIsImNyZWF0ZWQiOjE3ODM5MjA2ODU0MzEsImV4aXN0aW5nIjp0cnVlfQ==",
        "id": 4
    },
    {
        "domain": "supportal-tst.practiceplan.co.uk",
        "expirationDate": 1815456730.669637,
        "hostOnly": true,
        "httpOnly": true,
        "name": "nr1Users",
        "path": "/",
        "sameSite": "unspecified",
        "secure": true,
        "session": false,
        "storeId": "0",
        "value": "lid%3dWXy%2b3Kb9emlvq1l8QlrY0Q%3d%3dXBXO%2bj%2b1mOiRxNHavOGO7w%3d%3d%3btuu%3d63919517837%3bexp%3d63922109537%3brhs%3diHklyZfvaCbVgqYbgVHNWZ20xdI%3d%3bhmc%3dpNtyzaONxNfBBuz9QGYp674GayQ%3d",
        "id": 5
    },
    {
        "domain": "supportal-tst.practiceplan.co.uk",
        "expirationDate": 1815456730.669983,
        "hostOnly": true,
        "httpOnly": false,
        "name": "nr2Users",
        "path": "/",
        "sameSite": "unspecified",
        "secure": true,
        "session": false,
        "storeId": "0",
        "value": "crf%3dyfD0%2bSoK4jFrMpb%2bSW3Yi52N9dQ%3d%3buid%3d40882%3bunm%3dtestautomation%40ppp.in",
        "id": 6
    },
    {
        "domain": "supportal-tst.practiceplan.co.uk",
        "expirationDate": 1783922535.213086,
        "hostOnly": true,
        "httpOnly": true,
        "name": "osVisit",
        "path": "/",
        "sameSite": "unspecified",
        "secure": true,
        "session": false,
        "storeId": "0",
        "value": "997e2bd5-84db-48fd-bb76-fa26425f7e8a",
        "id": 7
    },
    {
        "domain": "supportal-tst.practiceplan.co.uk",
        "expirationDate": 1818050275.414899,
        "hostOnly": true,
        "httpOnly": true,
        "name": "osVisitor",
        "path": "/",
        "sameSite": "unspecified",
        "secure": true,
        "session": false,
        "storeId": "0",
        "value": "5c43bc8e-12ea-4adc-a326-2107a9b3646e",
        "id": 8
    }
];

// Helper to sanitize sameSite values to standard Playwright structure
const sanitizeCookies = (cookies) => {
    return cookies.map(cookie => {
        const sanitized = { ...cookie };
        // Map expirationDate to expires
        if (sanitized.expirationDate) {
            sanitized.expires = sanitized.expirationDate;
            delete sanitized.expirationDate;
        }
        if (sanitized.sameSite) {
            const val = sanitized.sameSite.toLowerCase();
            if (val === 'strict') {
                sanitized.sameSite = 'Strict';
            } else if (val === 'lax') {
                sanitized.sameSite = 'Lax';
            } else if (val === 'none' || val === 'no_restriction') {
                sanitized.sameSite = 'None';
            } else {
                delete sanitized.sameSite;
            }
        }
        return sanitized;
    });
};

async function run() {
    console.log("Launching browser...");
    const browser = await chromium.launch({ headless: true });
    
    // Add cookies to context
    const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ignoreHTTPSErrors: true
    });
    
    const sanitized = sanitizeCookies(cookies);
    console.log(`Injecting ${sanitized.length} cookies...`);
    await context.addCookies(sanitized);
    
    const page = await context.newPage();
    
    // Listen for any console errors
    page.on('pageerror', err => {
        console.error('PAGE ERROR (JS Exception):', err.message);
        console.error(err.stack);
    });
    
    page.on('console', msg => {
        if (msg.type() === 'error') {
            console.log('CONSOLE ERROR:', msg.text());
        }
    });

    try {
        console.log("Navigating to Dashboard...");
        await page.goto('https://supportal-tst.practiceplan.co.uk/Portal/Dashboard', { waitUntil: 'load', timeout: 30000 });
        
        console.log("Waiting for page stability / network idle...");
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(3000);
        
        console.log("Current URL:", page.url());
        
        // Check if error screen buttons are visible
        const showDetailBtn = page.locator('#error-screen-show-detail-button');
        const isErrorScreenVisible = await showDetailBtn.isVisible().catch(() => false);
        
        if (isErrorScreenVisible) {
            console.log("\n⚠️ OutSystems Error Screen Detected!");
            
            // Extract the main visible error text
            const errorText = await page.locator('.error-screen-message-text, .error-screen-message').innerText().catch(() => 'No text container found');
            console.log("Visible Error Text:", errorText);
            
            // Click "Show Detail"
            console.log("Clicking 'Show Detail' button...");
            await showDetailBtn.click();
            await page.waitForTimeout(1000);
            
            // Extract the detailed message / stack trace
            const detailedText = await page.locator('.error-screen-detail-text, pre, [id*="detail"]').innerText().catch(() => 'No detailed pre/text element found');
            console.log("\n--- DETAILED ERROR LOG ---");
            console.log(detailedText);
            console.log("--------------------------");
            
            // Dump full body HTML for further inspection
            const bodyHtml = await page.locator('body').innerHTML();
            console.log("\nBody HTML Snippet around error screen:");
            console.log(bodyHtml.substring(0, 1000));
        } else {
            console.log("No error screen visible. Main elements count:");
            const bodyHtml = await page.locator('body').innerHTML();
            console.log(bodyHtml.substring(0, 1000));
        }
        
    } catch (err) {
        console.error("Execution failed:", err);
    } finally {
        await browser.close();
    }
}

run().catch(console.error);
