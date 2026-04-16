const API_URL = "http://localhost:3001/api";

export const convertProject = async (zipFile, targetFramework, apiKey) => {
    const formData = new FormData();
    formData.append("projectZip", zipFile);
    formData.append("targetFramework", targetFramework);

    try {
        const response = await fetch(`${API_URL}/convert`, {
            method: "POST",
            headers: {
                "x-api-key": apiKey,
            },
            body: formData,
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || `Migration failed with status: ${response.status}`);
        }

        // Return the blob (zip file)
        return await response.blob();
    } catch (error) {
        console.error("Migration Service Error:", error);
        throw error;
    }
};
