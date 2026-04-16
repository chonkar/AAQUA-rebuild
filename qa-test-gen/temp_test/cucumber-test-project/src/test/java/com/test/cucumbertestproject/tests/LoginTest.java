package com.test.cucumbertestproject.tests;

import com.test.cucumbertestproject.pages.LoginPage;
import com.test.cucumbertestproject.utils.ConfigReader;
import org.testng.annotations.Test;
import org.testng.Assert;

public class LoginTest extends BaseTest {

    @Test
    public void testLogin() {
        LoginPage loginPage = new LoginPage(driver);
        String baseUrl = ConfigReader.getProperty("base.url");
        loginPage.navigateTo(baseUrl + "/login");
        loginPage.login("testuser", "password123");
        Assert.assertTrue(driver.getCurrentUrl().contains("dashboard"), "Login failed!");
    }
}