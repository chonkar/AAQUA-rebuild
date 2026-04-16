import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';

async function testCucumberGeneration() {
    const projectName = 'cucumber-test-project';
    const config = {
        projectName,
        framework: 'Selenium',
        language: 'Java',
        features: {
            pageObjectModel: true,
            reporting: 'Allure',
            cicd: 'GitHub Actions',
            docker: true,
            parallel: true,
            logging: true,
            cucumber: true
        }
    };

    console.log('Testing Cucumber Framework Generation...');

    try {
        const response = await fetch('http://localhost:3001/api/generate-framework', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });

        if (!response.ok) {
            throw new Error(`Generation failed: ${response.statusText}`);
        }

        const buffer = await response.arrayBuffer();
        const zipPath = path.join('temp_test', `${projectName}.zip`);
        const extractPath = path.join('temp_test', projectName);

        if (!fs.existsSync('temp_test')) fs.mkdirSync('temp_test');
        fs.writeFileSync(zipPath, Buffer.from(buffer));

        const zip = new AdmZip(zipPath);
        zip.extractAllTo(extractPath, true);

        console.log('✅ Framework generated and extracted.');

        // Verify folder structure
        const expectedFiles = [
            'pom.xml',
            'src/test/resources/testng.xml',
            'src/test/resources/features/login.feature',
            `src/test/java/com/test/cucumbertestproject/runners/CucumberTestRunner.java`,
            `src/test/java/com/test/cucumbertestproject/stepdefinitions/LoginStepDefinitions.java`
        ];

        for (const file of expectedFiles) {
            const filePath = path.join(extractPath, file);
            if (fs.existsSync(filePath)) {
                console.log(`✅ Verified: ${file}`);
            } else {
                console.error(`❌ Missing: ${file}`);
            }
        }

        // Verify pom.xml content
        const pomContent = fs.readFileSync(path.join(extractPath, 'pom.xml'), 'utf-8');
        if (pomContent.includes('<cucumber.version>7.18.0</cucumber.version>')) {
            console.log('✅ Verified: pom.xml contains cucumber version');
        } else {
            console.error('❌ Missing: cucumber version in pom.xml');
        }

        if (pomContent.includes('cucumber-java')) {
            console.log('✅ Verified: pom.xml contains cucumber-java dependency');
        } else {
            console.error('❌ Missing: cucumber-java dependency in pom.xml');
        }

        // Verify testng.xml content
        const testngContent = fs.readFileSync(path.join(extractPath, 'src', 'test', 'resources', 'testng.xml'), 'utf-8');
        if (testngContent.includes('runners.CucumberTestRunner')) {
            console.log('✅ Verified: testng.xml uses CucumberTestRunner');
        } else {
            console.error('❌ Missing: CucumberTestRunner in testng.xml');
        }

    } catch (err) {
        console.error('Test Failed:', err.message);
    } finally {
        // Cleanup
        // fs.rmSync('temp_test', { recursive: true, force: true });
    }
}

testCucumberGeneration();
