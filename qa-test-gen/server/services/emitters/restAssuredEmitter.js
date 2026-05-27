/**
 * REST Assured (Java + TestNG + Maven) emitter — Phase A3.
 *
 * Template-driven on purpose: the LLM produced the abstract cases (A2); here we
 * deterministically render them to compilable Java so there's no hallucinated
 * syntax. Plain-English assertions become comments above each call (they can't
 * be auto-coded reliably); the status code is asserted concretely.
 *
 * Input: { info: { title, serverUrl }, groups: [{ operationId, method, path, tags, secured, cases }] }
 * Output: { [relativePath]: fileContents }  — ready to zip.
 */

const PKG = 'com.aaqua.apitests';
const PKG_PATH = 'src/test/java/com/aaqua/apitests';

export function emitRestAssured({ info = {}, groups = [] }) {
    const files = {};
    const serverUrl = info.serverUrl || 'https://api.example.com';

    files['pom.xml'] = pom(info.title || 'api-tests');
    files['testng.xml'] = testngXml(groups);
    files['src/test/resources/config.properties'] = `base.uri=${serverUrl}\nauth.token=\n`;
    files[`${PKG_PATH}/BaseApiTest.java`] = baseClass(serverUrl);
    files['README.md'] = readme(serverUrl);

    // One Java test class per tag (fallback "Default").
    const byTag = groupByTag(groups);
    for (const [tag, tagGroups] of Object.entries(byTag)) {
        const className = `${pascal(tag)}ApiTest`;
        files[`${PKG_PATH}/${className}.java`] = testClass(className, tagGroups);
    }

    return files;
}

function groupByTag(groups) {
    const out = {};
    for (const g of groups) {
        const tag = (Array.isArray(g.tags) && g.tags[0]) || 'Default';
        (out[tag] = out[tag] || []).push(g);
    }
    return out;
}

function testClass(className, groups) {
    const methods = [];
    const used = new Set();
    for (const g of groups) {
        for (let i = 0; i < (g.cases || []).length; i++) {
            methods.push(testMethod(g, g.cases[i], i, used));
        }
    }
    return `package ${PKG};

import io.restassured.http.ContentType;
import org.testng.annotations.Test;
import static io.restassured.RestAssured.given;

public class ${className} extends BaseApiTest {

${methods.join('\n\n')}
}
`;
}

function testMethod(group, testCase, idx, used) {
    const method = (testCase.request?.method || group.method || 'GET').toLowerCase();
    const rawPath = testCase.request?.path || group.path || '/';
    const expected = toInt(testCase.expectedStatus, 200);
    const isAuthNegative = (testCase.category || '').toLowerCase() === 'auth';
    const includeAuth = group.secured && !isAuthNegative;

    let name = uniqueName(sanitizeMethod(testCase.name || `${testCase.category || 'case'}_${idx}`), used);

    const lines = [];
    lines.push('    @Test');
    lines.push(`    public void ${name}() {`);
    // Assertions as comments — verifiable intent for the engineer to flesh out.
    if (Array.isArray(testCase.assertions) && testCase.assertions.length > 0) {
        lines.push('        // Assertions to verify:');
        for (const a of testCase.assertions) lines.push(`        //  - ${escapeComment(a)}`);
    }
    lines.push('        given()');
    lines.push('            .baseUri(BASE_URI)');
    if (includeAuth) lines.push('            .header("Authorization", "Bearer " + TOKEN)');

    const pathParams = testCase.request?.pathParams || {};
    for (const [k, v] of Object.entries(pathParams)) {
        lines.push(`            .pathParam(${jstr(k)}, ${jstr(String(v))})`);
    }
    const queryParams = testCase.request?.queryParams || {};
    for (const [k, v] of Object.entries(queryParams)) {
        lines.push(`            .queryParam(${jstr(k)}, ${jstr(String(v))})`);
    }
    const body = testCase.request?.body;
    if (body !== undefined && body !== null && body !== '') {
        lines.push('            .contentType(ContentType.JSON)');
        lines.push(`            .body(${javaTextBlock(bodyToJson(body))})`);
    }
    lines.push('        .when()');
    lines.push(`            .${method}(${jstr(rawPath)})`);
    lines.push('        .then()');
    lines.push(`            .statusCode(${expected});`);
    lines.push('    }');
    return lines.join('\n');
}

function baseClass(serverUrl) {
    return `package ${PKG};

/**
 * Base for API tests. Override the server URL / token at runtime:
 *   mvn test -DbaseUri=https://your.api -DauthToken=xxxxx
 */
public class BaseApiTest {
    protected static final String BASE_URI = System.getProperty("baseUri", ${jstr(serverUrl)});
    protected static final String TOKEN = System.getProperty("authToken", "");
}
`;
}

function pom(name) {
    const artifact = sanitizeArtifact(name);
    return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>
    <groupId>com.aaqua</groupId>
    <artifactId>${artifact}</artifactId>
    <version>1.0.0</version>
    <properties>
        <maven.compiler.release>17</maven.compiler.release>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    </properties>
    <dependencies>
        <dependency>
            <groupId>io.rest-assured</groupId>
            <artifactId>rest-assured</artifactId>
            <version>5.4.0</version>
            <scope>test</scope>
        </dependency>
        <dependency>
            <groupId>org.testng</groupId>
            <artifactId>testng</artifactId>
            <version>7.10.2</version>
            <scope>test</scope>
        </dependency>
    </dependencies>
    <build>
        <plugins>
            <plugin>
                <groupId>org.apache.maven.plugins</groupId>
                <artifactId>maven-surefire-plugin</artifactId>
                <version>3.2.5</version>
                <configuration>
                    <suiteXmlFiles>
                        <suiteXmlFile>testng.xml</suiteXmlFile>
                    </suiteXmlFiles>
                </configuration>
            </plugin>
        </plugins>
    </build>
</project>
`;
}

function testngXml(groups) {
    const classes = Object.keys(groupByTag(groups))
        .map(tag => `            <class name="${PKG}.${pascal(tag)}ApiTest"/>`)
        .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE suite SYSTEM "https://testng.org/testng-1.0.dtd">
<suite name="API Test Suite">
    <test name="API Tests">
        <classes>
${classes}
        </classes>
    </test>
</suite>
`;
}

function readme(serverUrl) {
    return `# Generated REST Assured API Tests

Generated by AAQUA from your OpenAPI spec.

## Run
\`\`\`bash
mvn test -DbaseUri=${serverUrl} -DauthToken=<your-token>
\`\`\`

- \`baseUri\` overrides the target server (defaults to the spec's server URL).
- \`authToken\` is sent as \`Authorization: Bearer <token>\` for secured endpoints.

> Each test asserts the HTTP status code. The plain-English assertions from the
> AI design are included as comments — flesh them out into body assertions as needed.
`;
}

// ─── helpers ─────────────────────────────────────────────
function toInt(v, dflt) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : dflt; }
function bodyToJson(body) { return typeof body === 'string' ? body : JSON.stringify(body, null, 2); }
function jstr(s) { return JSON.stringify(String(s)); } // safe Java string literal (same escaping as JSON)
function javaTextBlock(s) { return '"""\n' + String(s).replace(/\\/g, '\\\\') + '\n"""'; }
function escapeComment(s) { return String(s).replace(/\r?\n/g, ' '); }
function pascal(s) {
    return String(s).replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('') || 'Default';
}
function sanitizeMethod(s) {
    let m = String(s).replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!m || /^[0-9]/.test(m)) m = 'test_' + m;
    return m;
}
function uniqueName(name, used) {
    let n = name, i = 2;
    while (used.has(n)) n = `${name}_${i++}`;
    used.add(n);
    return n;
}
function sanitizeArtifact(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'api-tests'; }
