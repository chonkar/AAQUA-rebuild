package com.test.cucumbertestproject.stepdefinitions;

import com.test.cucumbertestproject.pages.LoginPage;
import com.test.cucumbertestproject.utils.ConfigReader;
import com.test.cucumbertestproject.utils.DriverManager;
import io.cucumber.java.en.Given;
import io.cucumber.java.en.Then;
import io.cucumber.java.en.When;
import org.testng.Assert;

public class LoginStepDefinitions {
    private LoginPage loginPage;

    @Given("I am on the login page")
    public void i_am_on_the_login_page() {
        DriverManager.setDriver();
        loginPage = new LoginPage(DriverManager.getDriver());
        String baseUrl = ConfigReader.getProperty("base.url");
        loginPage.navigateTo(baseUrl + "/login");
    }

    @When("I enter valid username and password")
    public void i_enter_valid_username_and_password() {
        loginPage.login("testuser", "password123");
    }

    @Then("I should be redirected to the dashboard")
    public void i_should_be_redirected_to_the_dashboard() {
        Assert.assertTrue(DriverManager.getDriver().getCurrentUrl().contains("dashboard"));
        DriverManager.quitDriver();
    }
}