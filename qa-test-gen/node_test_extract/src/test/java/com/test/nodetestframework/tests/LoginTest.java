package com.test.nodetestframework.tests;

import com.test.nodetestframework.pages.LoginPage;
import org.testng.annotations.Test;
import org.testng.Assert;

public class LoginTest extends BaseTest {

    @Test
    public void testLogin() {
        driver.get("https://example.com/login");
        
        LoginPage loginPage = new LoginPage(driver);
        loginPage.login("testuser", "password123");
        
        Assert.assertTrue(driver.getCurrentUrl().contains("dashboard"), "Login failed!");
    }
}