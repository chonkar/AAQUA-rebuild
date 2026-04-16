package com.test.cucumbertestproject.utils;

import org.openqa.selenium.WebDriver;
import org.openqa.selenium.chrome.ChromeDriver;
import org.openqa.selenium.chrome.ChromeOptions;
import org.openqa.selenium.firefox.FirefoxDriver;
import org.openqa.selenium.edge.EdgeDriver;
import io.github.bonigarcia.wdm.WebDriverManager;
import java.time.Duration;

public class DriverManager {
    private static final ThreadLocal<WebDriver> driver = new ThreadLocal<>();

    public static void setDriver() {
        String browser = ConfigReader.getProperty("browser") != null ? ConfigReader.getProperty("browser").toLowerCase() : "chrome";
        boolean headless = ConfigReader.getBoolean("headless");
        int implicitWait = Integer.parseInt(ConfigReader.getProperty("implicit.wait"));

        WebDriver instance;

        switch (browser) {
            case "firefox":
                WebDriverManager.firefoxdriver().setup();
                instance = new FirefoxDriver();
                break;
            case "edge":
                WebDriverManager.edgedriver().setup();
                instance = new EdgeDriver();
                break;
            case "chrome":
            default:
                WebDriverManager.chromedriver().setup();
                ChromeOptions options = new ChromeOptions();
                options.addArguments("--remote-allow-origins=*");
                if (headless) options.addArguments("--headless");
                instance = new ChromeDriver(options);
                break;
        }
        
        instance.manage().window().maximize();
        instance.manage().timeouts().implicitlyWait(Duration.ofSeconds(implicitWait));
        driver.set(instance);
    }

    public static WebDriver getDriver() {
        return driver.get();
    }

    public static void quitDriver() {
        if (driver.get() != null) {
            driver.get().quit();
            driver.remove();
        }
    }
}