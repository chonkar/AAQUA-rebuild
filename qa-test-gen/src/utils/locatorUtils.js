const getPlaywrightLocatorStr = (tagName, id, css, xpath, _label) => {
    if (id) return `page.locator('#${id}')`;
    if (css && !css.includes(' > ')) return `page.locator('${css}')`;
    if (xpath) return `page.locator('xpath=${xpath}')`;
    return `page.locator('${css}')`;
};

const getSeleniumLocatorStr = (tagName, id, css, xpath) => {
    if (id) return `By.id("${id}")`;
    if (css && !css.includes(' > ')) {
        if (css.includes('[name="')) {
            const nameMatch = css.match(/name="([^"]+)"/);
            if (nameMatch) return `By.name("${nameMatch[1]}")`;
        }
        return `By.cssSelector("${css}")`;
    }
    if (xpath) return `By.xpath("${xpath}")`;
    return `By.cssSelector("${css}")`;
};

export const generateBoilerplateLocators = (htmlString) => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlString, 'text/html');
    const locators = [];

    // Expanded query for interactive elements, including OutSystems and general clickables
    const elements = doc.querySelectorAll('button, input, textarea, select, a, [role="button"], [data-button], [data-link], [data-input], .cursorpointer, .clickable, .OSInteractive, [onclick]');

    elements.forEach((el, index) => {
        let confidence = 0.5;
        let css = '';
        let xpath = '';
        let reason = 'Heuristic';

        const tagName = el.tagName.toLowerCase();
        const id = el.id;
        const name = el.getAttribute('name');
        const testId = el.getAttribute('data-testid') || el.getAttribute('data-cy');
        let label = el.textContent?.trim().slice(0, 30).replace(/\n/g, ' ') || '';

        // Improve label finding for inputs
        if (!label && (tagName === 'input' || tagName === 'textarea')) {
            if (id) {
                const labelEl = doc.querySelector(`label[for="${id}"]`);
                if (labelEl) label = labelEl.textContent?.trim();
            }
            if (!label) {
                label = el.getAttribute('placeholder') || el.getAttribute('value') || name || '';
            }
        }

        // CSS Strategy
        if (id && isUnique(doc, `#${id}`)) {
            css = `#${id}`;
            confidence = 1.0;
            reason = 'Unique ID';
        } else if (testId && isUnique(doc, `[data-testid="${testId}"]`)) {
            css = `[data-testid="${testId}"]`;
            confidence = 0.95;
            reason = 'Test ID';
        } else if (name && isUnique(doc, `${tagName}[name="${name}"]`)) {
            css = `${tagName}[name="${name}"]`;
            confidence = 0.9;
            reason = 'Unique Name';
        } else {
            // Fallback: Path
            css = getCssPath(el);
            confidence = 0.4; // Low confidence implies need for AI
            reason = 'Index-based (Weak)';
        }

        // XPath Strategy
        if (id) {
            xpath = `//*[@id="${id}"]`;
        } else if (label && isUniqueXPath(doc, `//${tagName}[text()="${label}"]`)) {
            xpath = `//${tagName}[normalize-space()="${label}"]`;
            if (confidence < 0.8) {
                confidence = 0.85;
                reason = 'Unique Text';
            }
        } else {
            xpath = getXPath(el);
        }

        locators.push({
            element: label || `${tagName} ${index}`,
            type: tagName,
            id: id || null,
            css,
            xpath,
            playwright: getPlaywrightLocatorStr(tagName, id, css, xpath, label),
            selenium: getSeleniumLocatorStr(tagName, id, css, xpath),
            confidence,
            reason,
            snippet: el.outerHTML.slice(0, 400),
            source: 'Code'
        });
    });

    return locators;
};

const isUnique = (root, selector) => {
    try { return root.querySelectorAll(selector).length === 1; }
    catch { return false; }
};

const isUniqueXPath = (root, xpath) => {
    try {
        const result = document.evaluate(xpath, root, null, XPathResult.ANY_TYPE, null);
        let count = 0;
        while (result.iterateNext()) count++;
        return count === 1;
    } catch { return false; }
};

const getCssPath = (el) => {
    if (!(el instanceof Element)) return '';
    const path = [];
    while (el.nodeType === Node.ELEMENT_NODE) {
        let selector = el.nodeName.toLowerCase();
        if (el.id) {
            selector += '#' + el.id;
            path.unshift(selector);
            break;
        } else {
            let sib = el.previousElementSibling;
            let nth = 1;
            while (sib) {
                if (sib.nodeName.toLowerCase() === selector) nth++;
                sib = sib.previousElementSibling;
            }
            if (nth != 1) selector += `:nth-of-type(${nth})`;
        }
        path.unshift(selector);
        el = el.parentNode;
    }
    return path.join(' > ');
};

const getXPath = (el) => {
    if (el.id) return `//*[@id="${el.id}"]`;
    if (el === document.body) return '/html/body';

    const tagName = el.tagName.toLowerCase();

    // 1. Try Attributes (Smart Cleanup)
    const atts = ['data-testid', 'data-cy', 'name', 'placeholder', 'title', 'alt', 'type', 'href', 'role'];
    for (const attr of atts) {
        const val = el.getAttribute(attr);
        if (val) {
            // Handle JSESSIONID or dynamic URL params
            if ((attr === 'href' || attr === 'action' || attr === 'src') && val.toLowerCase().includes('jsessionid')) {
                const cleanVal = val.split(/;jsessionid|\?jsessionid/i)[0];
                if (cleanVal && cleanVal.length > 1) {
                    return `//${tagName}[contains(@${attr}, "${cleanVal}")]`;
                }
                continue;
            }
            return `//${tagName}[@${attr}="${val}"]`;
        }
    }

    // 2. Try Text (short)
    const text = el.textContent?.trim();
    if (text && text.length < 50 && !text.includes("'")) {
        return `//${tagName}[normalize-space()='${text}']`;
    }

    // 3. Parent fallback
    if (el.parentElement && el.parentElement !== document.body) {
        return `//${el.parentElement.tagName.toLowerCase()}/${tagName}`;
    }

    return `//${tagName}`;
};
