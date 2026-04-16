package com.test.cucumbertestproject.pages;

import org.openqa.selenium.WebDriver;
import org.openqa.selenium.WebElement;
import org.openqa.selenium.support.PageFactory;
import com.test.cucumbertestproject.utils.WaitUtils;
import com.test.cucumbertestproject.utils.ConfigReader;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;

public class BasePage {
    protected WebDriver driver;
    protected WaitUtils waitUtils;
    protected static final Logger logger = LogManager.getLogger(BasePage.class);

    public BasePage(WebDriver driver) {
        this.driver = driver;
        int explicitWait = Integer.parseInt(ConfigReader.getProperty("explicit.wait"));
        this.waitUtils = new WaitUtils(driver, explicitWait);
        PageFactory.initElements(driver, this);
    }
    
    public void navigateTo(String url) {
        logger.info("Navigating to: " + url);
        driver.get(url);
    }
}