package com.test.verifyproj.tests;

import com.test.verifyproj.pages.LoginPage;
import org.testng.annotations.Test;
import org.testng.Assert;

public class LoginTest extends BaseTest {

    @Test
    public void testLogin() {
        LoginPage loginPage = new LoginPage(driver);
        loginPage.navigateTo("https://example.com/login");
        loginPage.login("testuser", "password123");
        
        Assert.assertTrue(driver.getCurrentUrl().contains("dashboard") || driver.getTitle().contains("Example"), "Login failed or verification mismtach!");
    }
}