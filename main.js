import * as THREE from 'three';
// Addons
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
// Post-processing
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// --- Configuration ---
const MATRIX_DROP_COUNT = 500;
const MATRIX_SPEED_MIN = 0.04;
const MATRIX_SPEED_MAX = 0.12;
const CHECK_INTERVAL_MS = 10000;
const PROXY_URL = 'http://localhost:8080/check';

// --- Status Colors (Matrix Theme) ---
const PENDING_COLOR = 0x33FF33;     // Light Green
const OK_COLOR = 0x00FF00;          // Bright Green
const ERROR_COLOR = 0xAA0000;       // Dark/Desaturated Red
const TIMEOUT_COLOR = 0x99FF99;     // Pale Green
const PROXY_ERROR_COLOR = 0x555555; // Dark Grey

// --- Globals ---
let scene, camera, renderer, css2DRenderer, controls, composer;
let matrixDrops = [];
let monitoredEndpoints = [];
let nextEndpointId = 0;
const endpointGrid = { cols: 6, spacing: 3.5 };

// Interaction Globals
let raycaster;
const mouse = new THREE.Vector2();
let selectedEndpointData = null;
let detailLabelObject = null;

// --- Initialization ---
function init() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    scene.fog = new THREE.FogExp2(0x000000, 0.03);

    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 6, 18);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    document.getElementById('webgl-container').appendChild(renderer.domElement);

    css2DRenderer = new CSS2DRenderer();
    css2DRenderer.setSize(window.innerWidth, window.innerHeight);
    css2DRenderer.domElement.style.position = 'absolute';
    css2DRenderer.domElement.style.top = '0px';
    css2DRenderer.domElement.style.pointerEvents = 'none';
    document.getElementById('css2d-labels').appendChild(css2DRenderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.screenSpacePanning = false;
    controls.minDistance = 3;
    controls.maxDistance = 70;
    controls.maxPolarAngle = Math.PI / 1.6;
    controls.target.set(0, 2, 0);
    controls.update();

    // Post-processing
    const renderScene = new RenderPass(scene, camera);
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.8, 0.3, 0.8);
    const outputPass = new OutputPass();
    composer = new EffectComposer(renderer);
    composer.addPass(renderScene);
    composer.addPass(bloomPass);
    composer.addPass(outputPass);

    // Lighting
    const ambientLight = new THREE.AmbientLight(0x10aa10, 1.0);
    scene.add(ambientLight);
    const pointLight = new THREE.PointLight(0x00ff00, 50, 30);
    pointLight.position.set(0, 5, 0);
    scene.add(pointLight);

    // Raycasting Setup
    raycaster = new THREE.Raycaster();
    window.addEventListener('pointerdown', onPointerDown, false);

    // Detail Panel Setup
    const detailDiv = document.createElement('div');
    detailDiv.className = 'detail-panel';
    detailDiv.style.display = 'none'; // Start hidden
    detailLabelObject = new CSS2DObject(detailDiv);
    detailLabelObject.visible = false; // Ensure Three.js visibility is also false
    scene.add(detailLabelObject);

    // Other Setup
    createMatrixBackground();
    document.getElementById('add-endpoint-btn').addEventListener('click', handleAddEndpoint);
    window.addEventListener('resize', onWindowResize, false);

    // Add Default Endpoints
    addDefaultEndpoints();

    // Start
    animate();
    setInterval(checkAllEndpoints, CHECK_INTERVAL_MS);
}

// --- Add Default Endpoints ---
function addDefaultEndpoints() {
    const defaults = [
        { domain: 'google.com', port: 443 },
        { domain: 'amazon.com', port: 443 },
        { domain: 'github.com', port: 443 }, // Changed hetzner to github for variety
        { domain: 'openai.com', port: 443 },
        { domain: 'cloudflare.com', port: 443 },
    ];
    defaults.forEach(site => {
        // Use the same logic as handleAddEndpoint uses internally
        const url = 'https://' + site.domain;
        addEndpointVisual(url, site.port);
    });
}


// --- Matrix Background Functions ---
// (Identical - createMatrixBackground, resetDrop, updateMatrixBackground)
function createMatrixBackground() { const dropGeometry = new THREE.PlaneGeometry(0.1, 0.5); const dropMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff00, side: THREE.DoubleSide, transparent: true, opacity: 0.7 }); for (let i = 0; i < MATRIX_DROP_COUNT; i++) { const drop = new THREE.Mesh(dropGeometry, dropMaterial.clone()); resetDrop(drop); drop.position.y = Math.random() * 70 - 35; scene.add(drop); matrixDrops.push(drop); } }
function resetDrop(drop) { drop.position.x = Math.random() * 60 - 30; drop.position.z = Math.random() * 60 - 30; drop.position.y = 35 + Math.random() * 10; drop.userData.speed = MATRIX_SPEED_MIN + Math.random() * (MATRIX_SPEED_MAX - MATRIX_SPEED_MIN); }
function updateMatrixBackground() { matrixDrops.forEach(drop => { drop.position.y -= drop.userData.speed; drop.material.opacity = Math.max(0.1, 1.0 - (35 - drop.position.y) / 40); if (drop.position.y < -35) { resetDrop(drop); } }); }


// --- Endpoint Monitoring & Visualization ---

// MODIFIED: Handles simplified input
function handleAddEndpoint() {
    const domainInput = document.getElementById('endpoint-domain');
    const portInput = document.getElementById('endpoint-port');

    let domainValue = domainInput.value.trim();
    const portString = portInput.value.trim();

    // --- Input Validation ---
    if (!domainValue) {
        alert('Please provide a domain name (e.g., example.com).');
        return;
    }

    // Remove potential http/https prefixes added by user
    domainValue = domainValue.replace(/^https?:\/\//, '');
    // Remove potential trailing slash
    domainValue = domainValue.replace(/\/$/, '');

    if (!domainValue) { // Check again after cleaning
        alert('Please provide a valid domain name.');
        return;
    }
    // Basic check for invalid characters (allow letters, numbers, hyphens, dots)
    if (!/^[a-zA-Z0-9.-]+$/.test(domainValue)) {
        alert('Domain name contains invalid characters.');
        return;
    }

    // Determine URL and Port
    const url = 'https://' + domainValue; // Default to HTTPS
    let port = 443; // Default port for HTTPS

    if (portString) {
        const parsedPort = parseInt(portString, 10);
        if (isNaN(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
            alert('Invalid port number provided. Must be between 1 and 65535.');
            return;
        }
        port = parsedPort;
    }
    // --- End Validation ---

    // Add the visual representation
    addEndpointVisual(url, port);

    // Clear the input fields
    domainInput.value = '';
    portInput.value = '';
}

// (addEndpointVisual remains largely the same, just uses the url/port passed in)
function addEndpointVisual(url, port) {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial({
        color: PENDING_COLOR, emissive: PENDING_COLOR, emissiveIntensity: 0.3,
        roughness: 0.6, metalness: 0.1
    });
    const cube = new THREE.Mesh(geometry, material);
    cube.userData.isEndpoint = true;

    const count = monitoredEndpoints.length;
    const gridX = (count % endpointGrid.cols) * endpointGrid.spacing - ((endpointGrid.cols - 1) * endpointGrid.spacing / 2);
    const gridY = 0;
    const gridZ = -Math.floor(count / endpointGrid.cols) * endpointGrid.spacing;
    cube.position.set(gridX, gridY + 0.5, gridZ);
    scene.add(cube);

    // Label Creation (remains the same)
    let displayUrl = url; try { const parsed = new URL(url); const isStd = (parsed.protocol === 'http:' && port === 80) || (parsed.protocol === 'https:' && port === 443); displayUrl = isStd ? parsed.hostname : `${parsed.hostname}:${port}`; if (displayUrl.length > 25) { displayUrl = displayUrl.substring(0, 22) + '...'; } } catch (e) { displayUrl = `${url}:${port}`; if (displayUrl.length > 25) { displayUrl = displayUrl.substring(0, 22) + '...'; } }
    const labelDiv = document.createElement('div'); labelDiv.className = 'endpoint-label status-pending'; labelDiv.textContent = displayUrl;
    const labelObject = new CSS2DObject(labelDiv); labelObject.position.set(0, 0.8, 0); cube.add(labelObject);

    // Store Endpoint Data
    const endpointData = {
        id: nextEndpointId++, url, port, displayUrl,
        mesh: cube, labelObject,
        status: 'PENDING', detailText: '', lastCheck: Date.now()
    };
    monitoredEndpoints.push(endpointData);
    cube.userData.endpointData = endpointData; // Link mesh back to data

    checkEndpointStatus(endpointData); // Initial check
}

// (checkEndpointStatus remains the same logic)
async function checkEndpointStatus(endpointData) {
    console.log(`Proxy check: ${endpointData.url}:${endpointData.port}`);
    updateEndpointVisual(endpointData, 'PENDING', '');

    try {
        const response = await fetch(PROXY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', }, body: JSON.stringify({ url: endpointData.url, port: endpointData.port }), });
        const data = await response.json();

        if (!response.ok) {
            console.error(`Proxy Error for ${endpointData.displayUrl}: Status ${response.status}, Detail: ${data.detail}`);
            const detail = data.detail || `Proxy responded with ${response.status}`;
            updateEndpointVisual(endpointData, data.status || 'PROXY_ERROR', detail);
        } else {
            console.log(`Proxy response for ${endpointData.displayUrl}:`, data);
            updateEndpointVisual(endpointData, data.status, data.detail || '');
        }

    } catch (error) {
        console.error(`Network error contacting proxy for ${endpointData.displayUrl}:`, error);
        updateEndpointVisual(endpointData, 'PROXY_ERROR', 'Network error: Cannot reach proxy');
    } finally {
        endpointData.lastCheck = Date.now();
        if (selectedEndpointData && selectedEndpointData.id === endpointData.id) {
            // Refresh detail panel if it's currently showing this endpoint
            showDetailPanel(selectedEndpointData);
        }
    }
}

// (updateEndpointVisual remains the same logic)
function updateEndpointVisual(endpointData, newStatus, detailText = '') {
    endpointData.status = newStatus;
    endpointData.detailText = detailText;

    let targetColor, statusClass = 'status-unknown', emissiveIntensity = 0.3;

    switch (newStatus) {
        case 'OK': targetColor = OK_COLOR; statusClass = 'status-ok'; emissiveIntensity = 0.6; break;
        case 'ERROR': targetColor = ERROR_COLOR; statusClass = 'status-error'; break;
        case 'TIMEOUT': targetColor = TIMEOUT_COLOR; statusClass = 'status-timeout'; break;
        case 'PROXY_ERROR': case 'INVALID_REQUEST': targetColor = PROXY_ERROR_COLOR; statusClass = 'status-proxy_error'; break;
        case 'PENDING': default: targetColor = PENDING_COLOR; statusClass = 'status-pending'; break;
    }

    if (endpointData.mesh.material.color.getHex() !== targetColor) {
        endpointData.mesh.material.color.setHex(targetColor);
        endpointData.mesh.material.emissive.setHex(targetColor);
        endpointData.mesh.material.emissiveIntensity = emissiveIntensity;
    }
    endpointData.labelObject.element.className = `endpoint-label ${statusClass}`;
}

// (checkAllEndpoints remains the same)
function checkAllEndpoints() { console.log("--- Periodic Checks ---"); monitoredEndpoints.forEach(ep => checkEndpointStatus(ep)); }


// --- Interaction ---

// MODIFIED: Handle toggle logic
function onPointerDown(event) {
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = - (event.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(scene.children, true);

    let foundEndpoint = false;
    let clickedData = null;

    for (let i = 0; i < intersects.length; i++) {
        let object = intersects[i].object;
        while (object) {
            if (object.userData.isEndpoint && object.userData.endpointData) {
                clickedData = object.userData.endpointData;
                foundEndpoint = true;
                break;
            }
            object = object.parent;
        }
        if (foundEndpoint) break;
    }

    if (foundEndpoint) {
        // Clicked on an endpoint cube
        if (selectedEndpointData && selectedEndpointData.id === clickedData.id) {
            // Clicked the SAME cube that is already selected -> Hide panel (toggle off)
            hideDetailPanel();
        } else {
            // Clicked a DIFFERENT cube (or no cube was selected before) -> Show panel
            selectedEndpointData = clickedData;
            showDetailPanel(selectedEndpointData);
        }
    } else {
        // Clicked on empty space -> Hide panel
        hideDetailPanel();
    }
}

// MODIFIED: Ensure visibility is correctly set
function showDetailPanel(endpointData) {
    if (!detailLabelObject) return;

    const div = detailLabelObject.element;
    div.style.display = 'block'; // Make HTML element visible
    detailLabelObject.visible = true; // Make Three.js object visible

    const now = Date.now();
    const elapsedSeconds = Math.round((now - endpointData.lastCheck) / 1000);
    const timeAgo = elapsedSeconds < 2 ? 'Just now' : (elapsedSeconds < 60 ? `${elapsedSeconds}s ago` : `${Math.floor(elapsedSeconds / 60)}m ago`);

    div.innerHTML = `
        <strong>Target:</strong> <span>${endpointData.displayUrl}</span><br>
        <strong>URL:</strong> <span style="font-size: 9px;">${endpointData.url}:${endpointData.port}</span><br>
        <strong>Status:</strong> <span class="status-${endpointData.status.toLowerCase()}">${endpointData.status}</span><br>
        <strong>Detail:</strong> <span style="word-break: break-all;">${endpointData.detailText || 'N/A'}</span><br>
        <strong>Checked:</strong> <span>${timeAgo}</span>
    `;

    // Position panel relative to the cube
    const offset = new THREE.Vector3(1.5, 1.5, 0); // Offset from cube center
    const worldPosition = endpointData.mesh.getWorldPosition(new THREE.Vector3());
    detailLabelObject.position.copy(worldPosition).add(offset);
}

// MODIFIED: Ensure visibility is correctly set and clear selection
function hideDetailPanel() {
    if (detailLabelObject) {
        detailLabelObject.element.style.display = 'none'; // Hide HTML element
        detailLabelObject.visible = false; // Hide Three.js object
    }
    selectedEndpointData = null; // Clear the selection
}


// --- Animation Loop --- (No changes needed here)
function animate() {
    requestAnimationFrame(animate);
    controls.update();
    updateMatrixBackground();

    monitoredEndpoints.forEach(ep => {
        if (ep.status === 'OK') {
            const time = Date.now() * 0.0025;
            ep.mesh.material.emissiveIntensity = 0.4 + Math.sin(time + ep.id) * 0.3;
        } else if (ep.mesh.material.emissiveIntensity > 0.3) {
            ep.mesh.material.emissiveIntensity = Math.max(0.3, ep.mesh.material.emissiveIntensity * 0.95);
        }
    });

    composer.render(); // Use composer for rendering
    css2DRenderer.render(scene, camera); // Render labels on top
}

// --- Event Handlers --- (No changes needed here)
function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
    css2DRenderer.setSize(window.innerWidth, window.innerHeight);
}

// --- Start Application ---
init();