(() => {
  const E = id => document.getElementById(id);
  const loopbackHosts = new Set(['127.0.0.1','localhost','::1']);
  const staticViewer = !loopbackHosts.has(location.hostname);
  const localApiBase = 'http://127.0.0.1:8922';
  const folderDatabase = 'astro-cad-viewer';
  const renderer = window.createSoftwareViewer(E('plot'), {
    solid:'#85b7c9', housing:'#e9edf4', stick:'#25292f', dpad:'#292c32',
    button_y:'#e0cf27', button_b:'#d95963', button_a:'#4ab568', button_x:'#39a8d5',
    system:'#30343a', bumper:'#929ca6'
  });
  const views = {
    iso:{eye:{x:1.7,y:-1.5,z:1.4},up:{x:0,y:0,z:1}},
    top:{eye:{x:0,y:0,z:2},up:{x:0,y:1,z:0}},
    front:{eye:{x:0,y:-2,z:0},up:{x:0,y:0,z:1}},
    side:{eye:{x:2,y:0,z:0},up:{x:0,y:0,z:1}}
  };
  let camera = views.iso, activeBuild = null, hidden = new Set(), drag = null;
  let fusionPlan = null, importing = false, stopFusionProgress = null;
  let jointValues = new Map();
  let selectedParts = new Set();
  let localObjectUrls = [];
  let localOutputDirectory = null;
  function details() {
    const all = E('show-all-details').checked;
    const parts = activeBuild?.parts.filter(p => selectedParts.has(p.name)) || [];
    E('selection-title').textContent = all ? 'Full model' : parts.length > 1 ? parts.length+' parts selected' : parts[0]?.name || 'Select a part';
    E('dimensions').replaceChildren(); E('parameters').replaceChildren();
    document.querySelectorAll('[data-part-name]').forEach(button => {
      button.classList.toggle('primary',selectedParts.has(button.dataset.partName));
      button.setAttribute('aria-pressed',String(selectedParts.has(button.dataset.partName)));
    });
    if (!activeBuild || (!all && !parts.length)) return;
    const entries = all ? [activeBuild.metadata] : parts;
    for (const part of entries) {
      if(entries.length>1) {row(E('dimensions'),part.name,'');row(E('parameters'),part.name,'');}
      if(part.size_mm) part.size_mm.forEach((size,i) => row(E('dimensions'),['X','Y','Z'][i],number(size)+' mm'));
      const parameters = part.parameters || {};
      for (const [key,value] of Object.entries(parameters)) {
        row(E('parameters'),key.replace(/_mm$/,'').replaceAll('_',' '),
          (typeof value === 'number' ? number(value) : String(value))+(key.endsWith('_mm')?' mm':''));
      }
      if (!Object.keys(parameters).length) row(E('parameters'),'Details','No part parameters defined');
    }
    row(E('dimensions'),'Measured in','Closed pose');
  }
  function selectPart(name, additive=false) {
    if (!additive) selectedParts.clear();
    if (name) {
      if(additive && selectedParts.has(name)) selectedParts.delete(name);
      else selectedParts.add(name);
    }
    E('show-all-details').checked=false; details(); draw();
  }
  function transformed(part) {
    let vertices = part.vertices;
    for (const joint of activeBuild.preview_joints || []) {
      if (!joint.parts.includes(part.name)) continue;
      const length = Math.hypot(...joint.axis), axis = joint.axis.map(v => v/length);
      const value = jointValues.get(joint) || 0;
      if (joint.type === 'slider') {
        vertices = vertices.map(vertex => vertex.map((n,i) => n+axis[i]*value));
        continue;
      }
      const angle = value * Math.PI / 180;
      const c = Math.cos(angle), s = Math.sin(angle);
      vertices = vertices.map(vertex => {
        const v = vertex.map((n,i) => n-joint.pivot_mm[i]);
        const dot = v.reduce((sum,n,i) => sum+n*axis[i],0);
        const cross = [axis[1]*v[2]-axis[2]*v[1],axis[2]*v[0]-axis[0]*v[2],axis[0]*v[1]-axis[1]*v[0]];
        return v.map((n,i) => joint.pivot_mm[i]+n*c+cross[i]*s+axis[i]*dot*(1-c));
      });
    }
    return vertices;
  }
  async function api(url, options={}, timeout=70000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const requestOptions = {...options,signal:controller.signal};
      if (staticViewer) requestOptions.targetAddressSpace = 'loopback';
      const response = await fetch((staticViewer ? localApiBase : '')+url,requestOptions);
      const data = await response.json();
      if (!response.ok) {
        const error = new Error(data.error || 'Fusion request failed.');
        error.details = data.details || data.progress?.error;
        error.reportUrl = data.report_url || data.progress?.report_url;
        error.progress = data.progress; error.resultUncertain = data.result_uncertain; throw error;
      }
      return data;
    } catch (error) {
      if (staticViewer && error.name === 'TypeError') {
        const networkError = new Error('Could not reach the local Fusion helper at 127.0.0.1:8922. Start the helper on this computer and allow the browser local-network prompt.');
        networkError.resultUncertain = url.startsWith('/api/fusion/import');
        throw networkError;
      }
      throw error;
    } finally {clearTimeout(timer);}
  }
  function formatDuration(seconds) {
    const value = Math.max(0,Math.floor(Number(seconds)||0));
    return value < 60 ? value+'s' : Math.floor(value/60)+'m '+String(value%60).padStart(2,'0')+'s';
  }
  function setFusionTrack(trackId, progressId, countId, label, completed, total) {
    const track = E(trackId), bar = E(progressId);
    track.hidden = total <= 0;
    bar.max = Math.max(1,total);
    bar.value = Math.min(Math.max(0,completed),total);
    E(countId).textContent = `${Math.min(Math.max(0,completed),total)} of ${total} ${label}`;
  }
  function fusionStage(progress) {
    if (progress.status==='uncertain') return 'Waiting for Fusion response';
    if (progress.status==='imported_unverified') return 'Import finished; verification incomplete';
    if (progress.status==='needs_attention') return 'Fusion needs attention';
    if (progress.status==='complete') return 'Import and verification complete';
    return ({
      connecting:'Connecting to Fusion', validating:'Checking approved STEP files',
      creating_component:'Creating the controller component', importing_parts:'Importing STEP parts into Fusion',
      creating_joints:'Creating assembly joints', import_complete:'STEP parts and joints imported; verifying structure',
      verifying_structure:'Verifying bodies, joints, axes, and travel', verifying_motion:'Checking native joint motion',
      complete:'Import and verification complete'
    })[progress.phase] || progress.message || 'Fusion is working';
  }
  function renderFusionProgress(progress) {
    const elapsed = formatDuration(progress.elapsed_seconds);
    const parts = Number.isFinite(progress.total_parts) ? `${progress.completed_parts||0}/${progress.total_parts} STEP parts imported` : '';
    const joints = Number.isFinite(progress.total_joints) ? `${progress.completed_joints||0}/${progress.total_joints} joints created` : '';
    const counts = [parts,joints].filter(Boolean).join('; ');
    const current = progress.current_item ? `${progress.current_item_state==='running'?'Current':'Last completed'}: ${progress.current_item}` : '';
    const currentTime = progress.current_item_state==='running' && progress.step_elapsed_seconds != null
      ? ` (${formatDuration(progress.step_elapsed_seconds)} on this step)`
      : progress.current_item_state==='completed' && progress.last_item_duration_seconds != null
        ? ` (${formatDuration(progress.last_item_duration_seconds)} for this step)` : '';
    if (progress.status==='uncertain') return `Fusion has not returned a final result. ${current || progress.message}${currentTime}. ${counts}. ${elapsed} elapsed. A long step alone does not confirm failure; inspect before retrying.`;
    if (progress.status==='imported_unverified') return `Fusion reports that import finished, but verification did not. ${current || progress.message}. ${counts}. ${elapsed} elapsed. Inspect before retrying.`;
    if (progress.phase==='import_complete') return `Fusion finished importing the parts and creating joints; verification has not returned yet. ${counts}. ${elapsed} elapsed.`;
    if (progress.status==='needs_attention') return `Fusion needs attention: ${progress.message}. ${current}. ${counts}. ${elapsed} elapsed.`;
    if (progress.phase==='verifying_motion' && Number.isFinite(progress.motion_total_joints)) {
      const motion = `${progress.motion_completed_joints||0}/${progress.motion_total_joints} motion checks complete`;
      return `${progress.message}. ${counts}; ${motion}. ${elapsed} elapsed.${current ? ' '+current+currentTime+'.' : ''}`;
    }
    if (progress.status==='complete') return `Import and verification complete. ${counts}. Total time ${elapsed}.`;
    return `${progress.message || 'Fusion is working'}. ${counts}. ${elapsed} elapsed.${current ? ' '+current+currentTime+'.' : ''}`;
  }
  function updateFusionProgressUi(progress) {
    const assembly = fusionPlan?.assembly;
    const expectedParts = assembly ? fusionPlan.part_exports.length : 1;
    const expectedJoints = assembly ? assembly.rigid.length+assembly.joints.length : 0;
    const expectedMotion = assembly ? assembly.joints.length : 0;
    setFusionTrack('fusion-parts-track','fusion-parts-progress','fusion-parts-count','STEP parts',
      progress.completed_parts ?? 0,progress.total_parts ?? expectedParts);
    setFusionTrack('fusion-joints-track','fusion-joints-progress','fusion-joints-count','joints',
      progress.completed_joints ?? 0,progress.total_joints ?? expectedJoints);
    setFusionTrack('fusion-motion-track','fusion-motion-progress','fusion-motion-count','motion checks',
      progress.motion_completed_joints ?? 0,progress.motion_total_joints ?? expectedMotion);
    E('fusion-stage').textContent = fusionStage(progress);
    E('fusion-elapsed').textContent = `${formatDuration(progress.elapsed_seconds)} elapsed`;
    E('fusion-tracker').hidden = false;
    E('fusion-progress').textContent = renderFusionProgress(progress);
  }
  function watchFusionProgress(plan) {
    let active = true;
    const requestBudget = Number(plan.import_mcp_timeout_seconds) || 180;
    const stopAt = Date.now()+Math.max(600000,(requestBudget+330)*1000);
    const query = new URLSearchParams({build_id:plan.build_id,plan_id:plan.plan_id});
    const task = (async () => {
      while (active && Date.now()<stopAt) {
        try {
          const progress = await api('/api/fusion/progress?'+query.toString(),{},8000);
          if (progress.status!=='not_started') updateFusionProgressUi(progress);
          if (['complete','needs_attention','imported_unverified'].includes(progress.status)) break;
        } catch {}
        if (active) await new Promise(resolve => setTimeout(resolve,1200));
      }
    })();
    return async () => {active=false; await task;};
  }
  async function fetchLocalAsset(url, timeout=30000, asJson=false) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const options = {signal:controller.signal};
      if (staticViewer) options.targetAddressSpace = 'loopback';
      const response = await fetch(localApiBase + url, options);
      if (!response.ok) {
        let message = 'The local helper could not load this model file.';
        try {message = (await response.json()).error || message;} catch {}
        throw new Error(message);
      }
      return asJson ? response.json() : response.blob();
    } catch (error) {
      if (staticViewer && error.name === 'TypeError') {
        throw new Error('Could not reach the local helper at 127.0.0.1:8922. Start it on this computer and allow the browser local-network prompt.');
      }
      throw error;
    } finally {clearTimeout(timer);}
  }
  function openFolderDatabase() {
    return new Promise((resolve,reject) => {
      const request = indexedDB.open(folderDatabase,1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('settings')) request.result.createObjectStore('settings');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open browser folder settings.'));
    });
  }
  async function savedOutputDirectory() {
    const database = await openFolderDatabase();
    return new Promise((resolve,reject) => {
      const request = database.transaction('settings','readonly').objectStore('settings').get('outputs');
      request.onsuccess = () => {database.close(); resolve(request.result || null);};
      request.onerror = () => {database.close(); reject(request.error || new Error('Could not read the saved folder.'));};
    });
  }
  async function rememberOutputDirectory(directory) {
    const database = await openFolderDatabase();
    return new Promise((resolve,reject) => {
      const transaction = database.transaction('settings','readwrite');
      transaction.objectStore('settings').put(directory,'outputs');
      transaction.oncomplete = () => {database.close(); resolve();};
      transaction.onerror = () => {database.close(); reject(transaction.error || new Error('Could not remember the selected folder.'));};
    });
  }
  function parseLocalPreview(source) {
    const prefix = 'window.CAD_PREVIEW=';
    const text = source.trim();
    if (!text.startsWith(prefix) || !text.endsWith(';')) throw new Error('The selected current.js is not a CAD preview generated by this project.');
    let payload;
    try { payload = JSON.parse(text.slice(prefix.length,-1)); }
    catch { throw new Error('The selected CAD preview file is not valid JSON.'); }
    const buildId = payload?.metadata?.build_id;
    if (typeof buildId !== 'string' || !/^\d{8}-\d{6}-[0-9a-f]{8}$/.test(buildId)) throw new Error('The selected CAD preview has an invalid build ID.');
    return payload;
  }
  function clearLocalObjectUrls() {
    for (const url of localObjectUrls) URL.revokeObjectURL(url);
    localObjectUrls = [];
  }
  function showLocalPreview(payload, stepFile, stlFile) {
    clearLocalObjectUrls();
    const stepUrl = URL.createObjectURL(stepFile), stlUrl = URL.createObjectURL(stlFile);
    localObjectUrls = [stepUrl,stlUrl];
    payload.metadata.step_url = stepUrl;
    payload.metadata.stl_url = stlUrl;
    delete payload.metadata.step_path;
    delete payload.metadata.source_path;
    if (Array.isArray(payload.metadata.part_exports)) {
      payload.metadata.part_exports = payload.metadata.part_exports.map(({step_path,...part}) => part);
    }
    show(payload);
    E('message').textContent = 'Loaded from your selected local folder. These files stay on your device.';
  }
  async function loadFromDirectory(directory) {
    const currentHandle = await directory.getFileHandle('current.js');
    const payload = parseLocalPreview(await (await currentHandle.getFile()).text());
    const buildDirectory = await (await directory.getDirectoryHandle('builds')).getDirectoryHandle(payload.metadata.build_id);
    const stepFile = await (await buildDirectory.getFileHandle('model.step')).getFile();
    const stlFile = await (await buildDirectory.getFileHandle('model.stl')).getFile();
    E('local-folder-status').textContent = 'Selected local outputs folder: ' + directory.name;
    showLocalPreview(payload,stepFile,stlFile);
  }
  async function loadFromLocalHelper() {
    const result = await fetchLocalAsset('/api/viewer/current',15000,true);
    const payload = result.preview;
    if (!payload?.metadata?.build_id) throw new Error('The local helper returned an invalid preview.');
    const revision = encodeURIComponent(payload.metadata.build_id);
    const [stepFile,stlFile] = await Promise.all([
      fetchLocalAsset('/api/viewer/artifact?revision='+revision+'&name=model.step'),
      fetchLocalAsset('/api/viewer/artifact?revision='+revision+'&name=model.stl')
    ]);
    E('local-folder-status').textContent = 'Selected local outputs folder: ' + (result.folder_path || 'outputs');
    showLocalPreview(payload,stepFile,stlFile);
  }
  async function refreshStaticViewer() {
    E('refresh').disabled = true;
    try {
      if (localOutputDirectory) await refreshLocalFolder();
      else await loadFromLocalHelper();
    } catch (error) {
      E('message').textContent = 'Could not load the default local outputs folder: ' + error.message + ' You can choose a local outputs folder below to view it without uploading the files.';
      E('local-folder-status').textContent = 'Default folder: outputs/ from the local helper. Choose another local outputs folder to override it.';
    } finally {E('refresh').disabled = false;}
  }
  async function refreshLocalFolder() {
    if (!localOutputDirectory) return chooseLocalFolder();
    E('refresh').disabled = true;
    try {
      if (localOutputDirectory.queryPermission) {
        let permission = await localOutputDirectory.queryPermission({mode:'read'});
        if (permission !== 'granted' && localOutputDirectory.requestPermission) {
          permission = await localOutputDirectory.requestPermission({mode:'read'});
        }
        if (permission !== 'granted') throw new Error('Folder access was not granted. Choose the folder again to reconnect.');
      }
      await loadFromDirectory(localOutputDirectory);
    } catch (error) {
      E('message').textContent = 'Could not refresh the selected folder: ' + error.message;
    } finally {E('refresh').disabled = false;}
  }
  function selectedFolderFiles() {
    const files = E('local-folder-input').files;
    if (!files.length) return;
    const byPath = new Map();
    for (const file of files) {
      const parts = (file.webkitRelativePath || file.name).replaceAll('\\','/').split('/');
      const outputsIndex = parts.lastIndexOf('outputs');
      const path = outputsIndex >= 0 ? parts.slice(outputsIndex+1).join('/') : parts.slice(1).join('/');
      byPath.set(path,file);
    }
    const currentFile = byPath.get('current.js');
    if (!currentFile) throw new Error('Choose the outputs folder that contains current.js and builds.');
    return {byPath,currentFile};
  }
  async function loadFromSelectedFiles() {
    const selected = selectedFolderFiles();
    if (!selected) return;
    const payload = parseLocalPreview(await selected.currentFile.text());
    const folder = 'builds/' + payload.metadata.build_id + '/';
    const stepFile = selected.byPath.get(folder + 'model.step');
    const stlFile = selected.byPath.get(folder + 'model.stl');
    if (!stepFile || !stlFile) throw new Error('The selected outputs folder is missing the current build STEP or STL export.');
    const rootName = (E('local-folder-input').files[0]?.webkitRelativePath || 'outputs').split('/')[0];
    E('local-folder-status').textContent = 'Selected local outputs folder: ' + rootName + ' (choose it again after refreshing this page)';
    E('choose-local-folder').textContent = 'Change folder';
    showLocalPreview(payload,stepFile,stlFile);
  }
  async function chooseLocalFolder() {
    E('choose-local-folder').disabled = true;
    try {
      if (window.showDirectoryPicker) {
        const directory = await window.showDirectoryPicker({id:'astro-cad-outputs',startIn:'documents',mode:'read'});
        localOutputDirectory = directory;
        E('local-folder-status').textContent = 'Selected local outputs folder: ' + directory.name;
        E('choose-local-folder').textContent = 'Change folder';
        E('refresh').disabled = false;
        E('refresh').textContent = 'Refresh local model';
        try {await rememberOutputDirectory(directory);}
        catch (error) {E('message').textContent = 'Folder selected, but this browser could not remember it: ' + error.message;}
        await loadFromDirectory(directory);
      } else {
        E('local-folder-input').click();
      }
    } catch (error) {
      if (error.name !== 'AbortError') E('message').textContent = 'Could not load that folder: ' + error.message;
    } finally {E('choose-local-folder').disabled = false;}
  }
  const number = value => Number(value).toLocaleString(undefined,{maximumFractionDigits:3});
  function draw() {
    if (!activeBuild) return;
    renderer.draw(activeBuild.parts.filter((_,index) => !hidden.has(index)), transformed, camera, false, {
      xy:E('grid-xy').checked,xz:E('grid-xz').checked,yz:E('grid-yz').checked,
      axes:E('grid-axes').checked,dimensions:E('grid-dimensions').checked &&
        (E('show-all-details').checked || activeBuild.parts.some((p,i) => selectedParts.has(p.name) && !hidden.has(i))),
      dimensionParts:E('show-all-details').checked ? null : selectedParts,
      selectedParts
    });
    E('grid-scale').textContent = 'Grid spacing: ' + (renderer.canvas.dataset.gridSpacing || '—') + ' mm';
  }
  function row(target, label, value) {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = label; dd.textContent = value; target.append(dt,dd);
  }
  function show(build) {
    if (!build?.metadata || !Array.isArray(build.parts) || !build.parts.length) throw new Error('The preview contains no model.');
    activeBuild = build; hidden = new Set();
    selectedParts = new Set();
    fusionPlan = null;
    jointValues = new Map();
    E('motion').replaceChildren();
    E('motion-section').hidden = !(build.preview_joints || []).length;
    const hasSliders = (build.preview_joints || []).some(joint => joint.type === 'slider');
    E('motion-note').textContent = (hasSliders ? 'Press/Release toggles each button; its range control selects partial travel. ' : '')+
      (build.metadata.assembly ? 'Fusion import creates separate components and native joints in the closed position. Browser motion positions are not imported.' : 'Browser movement only. Fusion import and STEP use the closed position without native joints.');
    for (const joint of build.preview_joints || []) {
      const row = document.createElement('div'), label = document.createElement('label'), slider = document.createElement('input'), output = document.createElement('output');
      const linear = joint.type === 'slider';
      row.className = 'motion-control';
      label.textContent = joint.name + ' '; output.textContent = linear ? '0 mm' : '0°';
      slider.type = 'range'; slider.min = linear ? joint.min_mm : joint.min_deg; slider.max = linear ? joint.max_mm : joint.max_deg; slider.step = 'any'; slider.value = 0;
      slider.setAttribute('aria-label',joint.name);
      let pressButton = null;
      const setValue = value => {
        slider.value = value;
        jointValues.set(joint,value);
        output.textContent = number(value)+(linear?' mm':'°');
        if (pressButton) pressButton.textContent = value ? 'Release' : 'Press';
        draw();
      };
      slider.oninput = () => setValue(Number(slider.value));
      label.append(output,slider); row.append(label);
      if (linear) {
        pressButton = document.createElement('button');
        pressButton.type = 'button'; pressButton.textContent = 'Press';
        pressButton.setAttribute('aria-label','Press or release '+joint.name);
        pressButton.onclick = () => setValue(Number(slider.value) ? 0 : joint.max_mm);
        row.append(pressButton);
      }
      E('motion').append(row);
    }
    const meta = build.metadata;
    E('name').textContent = meta.name;
    E('description').textContent = meta.description;
    E('status').textContent = 'Ready to review';
    E('message').textContent = 'Solid validity and STEP readability checks passed. Review the dimensions and shape before importing.';
    if(meta.motion_check?.passed) E('message').textContent += ' Motion screen: '+meta.motion_check.pose_count+' sampled poses without solid overlaps. Continuous motion and print tolerances are not certified.';
    E('dimensions').replaceChildren();
    meta.size_mm.forEach((size,index) => row(E('dimensions'), ['X','Y','Z'][index], number(size) + ' mm'));
    row(E('dimensions'),'Solids',meta.solid_count);
    E('parameters').replaceChildren();
    for (const [key,value] of Object.entries(meta.parameters)) {
      const label = key.replace(/_mm$/, '').replaceAll('_',' ');
      const display = typeof value === 'number' ? number(value) : String(value);
      row(E('parameters'),label,display + (key.endsWith('_mm') ? ' mm' : ''));
    }
    E('parts').replaceChildren();
    build.parts.forEach((part,index) => {
      const label = document.createElement('label'), input = document.createElement('input');
      input.type = 'checkbox'; input.checked = true; label.className = 'part';
      const button = document.createElement('button'); button.textContent=part.name;
      button.dataset.partName=part.name; button.onclick=event => selectPart(part.name,event.shiftKey);
      input.setAttribute('aria-label','Show '+part.name);
      label.append(input,button);
      input.onchange = () => {input.checked ? hidden.delete(index) : hidden.add(index); draw();};
      E('parts').append(label);
    });
    for (const type of ['step','stl']) {
      const link = E(type); link.href = meta[type + '_url']; link.classList.remove('disabled'); link.removeAttribute('aria-disabled');
      if (staticViewer) link.download = 'model.' + type;
    }
    E('copy-path').disabled = staticViewer || !meta.step_path;
    E('fusion').disabled = location.protocol === 'file:';
    if (staticViewer) E('fusion').title = 'Fusion import connects to the local helper on this computer at 127.0.0.1:8922. The revision must also exist in that helper’s outputs folder.';
    else if (location.protocol === 'file:') E('fusion').title = 'Open the localhost preview server to import into Fusion.';
    E('revision').textContent = 'Revision ' + meta.build_id;
    details();
    camera = views.iso; renderer.fit(); draw();
  }
  function load() {
    E('refresh').disabled = true;
    const script = document.createElement('script');
    script.src = 'outputs/current.js?t=' + Date.now();
    script.onload = () => {
      try {show(window.CAD_PREVIEW);} catch(error) {E('message').textContent = error.message;}
      E('refresh').disabled = false; script.remove();
    };
    script.onerror = () => {
      E('message').textContent = activeBuild ? 'Could not load a newer revision. The displayed revision and its exports are unchanged.' : 'No model built yet. Describe a part in chat to generate one.';
      E('refresh').disabled = false; script.remove();
    };
    document.head.append(script);
  }
  E('refresh').onclick = staticViewer ? refreshStaticViewer : load;
  E('choose-local-folder').onclick = chooseLocalFolder;
  E('local-folder-input').onchange = async () => {
    E('choose-local-folder').disabled = true;
    try {await loadFromSelectedFiles();}
    catch (error) {E('message').textContent = 'Could not load that folder: ' + error.message;}
    finally {E('choose-local-folder').disabled = false; E('local-folder-input').value = '';}
  };
  E('show-all-details').onchange = () => {details(); draw();};
  ['grid-xy','grid-xz','grid-yz','grid-axes','grid-dimensions'].forEach(id => E(id).onchange = draw);
  E('fusion').onclick = async () => {
    const revision = activeBuild.metadata.build_id;
    E('fusion').disabled = E('refresh').disabled = true;
    E('message').textContent = 'Checking the active Fusion design…';
    try {
      fusionPlan = await api('/api/fusion/plan?revision=' + encodeURIComponent(revision));
      if (activeBuild.metadata.build_id !== revision) throw new Error('The preview changed. Review the new revision before importing.');
      E('fusion-details').replaceChildren();
      row(E('fusion-details'),'Model',fusionPlan.model_name);
      row(E('fusion-details'),'Dimensions',fusionPlan.size_mm.map(number).join(' × ') + ' mm');
      row(E('fusion-details'),'Solid bodies',fusionPlan.solid_count);
      const assembly = fusionPlan.assembly;
      E('fusion-import-summary').textContent = assembly ? 'This adds an assembly in the closed position with separate components, a grounded base, and native joints. Browser slider positions are not imported.' : 'This adds all model bodies inside one new component.';
      if (assembly) {
        row(E('fusion-details'),'Components',fusionPlan.part_exports.length);
        row(E('fusion-details'),'Revolute joints',assembly.joints.filter(j => j.type==='revolute').length);
        row(E('fusion-details'),'Ball joints',assembly.joints.filter(j => j.type==='ball').length);
        row(E('fusion-details'),'Slider joints',assembly.joints.filter(j => j.type==='slider').length);
        row(E('fusion-details'),'Rigid joints',assembly.rigid.length);
        row(E('fusion-details'),'Grounded part',assembly.ground);
        row(E('fusion-details'),'Collision screen',fusionPlan.motion_check?.passed ? fusionPlan.motion_check.pose_count+' sampled poses passed' : 'Missing — rebuild required');
      }
      row(E('fusion-details'),'Revision',fusionPlan.build_id);
      row(E('fusion-details'),'Fusion design',fusionPlan.target.document_name);
      row(E('fusion-details'),'Parent component',fusionPlan.target.component_name);
      row(E('fusion-details'),'New component',fusionPlan.new_component_name);
      const importItemCount = assembly ? fusionPlan.part_exports.length : 1;
      row(E('fusion-details'),'Import progress',`${importItemCount} STEP item${importItemCount===1?'':'s'} reported individually`);
      row(E('fusion-details'),'Request safety limit',formatDuration(fusionPlan.import_mcp_timeout_seconds||180)+' per request (not an ETA)');
      E('fusion-tracker').hidden = true;
      E('fusion-progress').textContent = 'Check the model and destination, then approve the import.';
      E('fusion-error-details').hidden = true;
      E('fusion-confirm').disabled = E('fusion-cancel').disabled = false;
      E('fusion-review').showModal();
      E('message').textContent = 'Fusion destination ready for review.';
    } catch(error) {
      fusionPlan = null;
      E('message').textContent = 'Could not prepare the import: ' + error.message;
      E('fusion').disabled = E('refresh').disabled = false;
    }
  };
  E('fusion-review').addEventListener('cancel', event => {if (importing) event.preventDefault();});
  E('fusion-review').addEventListener('close', () => {
    if (stopFusionProgress) {const stop=stopFusionProgress; stopFusionProgress=null; void stop();}
    fusionPlan = null;
    E('fusion').disabled = E('refresh').disabled = false;
  });
  E('fusion-cancel').onclick = () => E('fusion-review').close();
  E('fusion-confirm').onclick = async () => {
    if (!fusionPlan || importing) return;
    importing = true;
    E('fusion-confirm').disabled = E('fusion-cancel').disabled = true;
    updateFusionProgressUi({phase:'connecting',status:'running',completed_parts:0,total_parts:fusionPlan.assembly ? fusionPlan.part_exports.length : 1,
      completed_joints:0,total_joints:fusionPlan.assembly ? fusionPlan.assembly.rigid.length+fusionPlan.assembly.joints.length : 0,
      motion_completed_joints:0,motion_total_joints:fusionPlan.assembly?.joints.length||0,elapsed_seconds:0,
      message:'Connecting to Fusion and checking the approved plan'});
    E('fusion-progress').textContent = 'Importing the approved revision into Fusion…';
    stopFusionProgress = watchFusionProgress(fusionPlan);
    let keepProgressWatch = false;
    try {
      const requestBudget = Number(fusionPlan.import_mcp_timeout_seconds) || 180;
      const browserWait = Math.max(610000,(requestBudget+330)*1000);
      const receipt = await api('/api/fusion/import', {
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({build_id:fusionPlan.build_id,plan_id:fusionPlan.plan_id,approved:true})
      },browserWait);
      E('message').textContent = 'Imported into ' + receipt.import.document_name + ' as ' + receipt.verification.component_name + '. Verified ' + receipt.verification.body_count + ' body/bodies' + (receipt.verification.joints?.length ? ' and '+receipt.verification.joints.length+' native joints.' : '.');
      E('status').textContent = 'Imported into Fusion';
      E('fusion-review').close();
    } catch(error) {
      keepProgressWatch = error.name==='AbortError' || error.resultUncertain===true
        || ['running','uncertain','imported_unverified'].includes(error.progress?.status);
      if (error.progress) updateFusionProgressUi(error.progress);
      else E('fusion-progress').textContent = error.name === 'AbortError' ? 'Import result is uncertain. Inspect Fusion before retrying.' : error.message;
      E('status').textContent = error.progress?.status==='running' ? 'Fusion import still running'
        : ['uncertain','imported_unverified'].includes(error.progress?.status) || error.resultUncertain ? 'Fusion import status uncertain'
          : error.progress?.status==='needs_attention' ? 'Fusion import needs attention' : 'Import failed / unverified';
      E('message').textContent = E('fusion-progress').textContent;
      E('fusion-error-details').hidden = false;
      E('fusion-error-details').open = true;
      E('fusion-error-text').textContent = error.details || error.message;
      E('fusion-error-report').hidden = !error.reportUrl;
      if(error.reportUrl) E('fusion-error-report').href=error.reportUrl;
      E('fusion-cancel').disabled = false;
    } finally {
      if (stopFusionProgress && !keepProgressWatch) {const stop=stopFusionProgress; stopFusionProgress=null; await stop();}
      importing = false;
    }
  };
  document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => {camera = views[button.dataset.view]; renderer.fit(); draw();});
  E('fit').onclick = () => {renderer.fit(); draw();};
  E('zoom-in').onclick = () => {renderer.zoomBy(1.25); draw();};
  E('zoom-out').onclick = () => {renderer.zoomBy(0.8); draw();};
  E('copy-path').onclick = async () => {
    try {await navigator.clipboard.writeText(activeBuild.metadata.step_path); E('message').textContent = 'STEP path copied for this revision.';}
    catch {E('message').textContent = 'STEP file: ' + activeBuild.metadata.step_path;}
  };
  renderer.canvas.onpointerdown = event => {
    drag = {x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,moved:false,pan:event.shiftKey}; renderer.canvas.setPointerCapture(event.pointerId);
  };
  renderer.canvas.onpointermove = event => {
    if (!drag) return;
    const dx = event.clientX-drag.x, dy = event.clientY-drag.y;
    if(Math.hypot(event.clientX-drag.startX,event.clientY-drag.startY)>4) drag.moved=true;
    if(!drag.moved) return;
    drag.x = event.clientX; drag.y = event.clientY;
    if (drag.pan) renderer.panBy(dx,dy);
    else {
      const v = camera.eye, radius = Math.hypot(v.x,v.y,v.z);
      const azimuth = Math.atan2(v.y,v.x) + dx*0.008;
      const elevation = Math.max(-1.5,Math.min(1.5,Math.asin(v.z/radius)+dy*0.008));
      camera = {eye:{x:radius*Math.cos(elevation)*Math.cos(azimuth),y:radius*Math.cos(elevation)*Math.sin(azimuth),z:radius*Math.sin(elevation)},up:{x:0,y:0,z:1}};
    }
    draw();
  };
  renderer.canvas.onpointerup = event => {
    if(drag && !drag.moved) selectPart(renderer.pick(event.clientX,event.clientY),event.shiftKey);
    drag=null;
  };
  renderer.canvas.onpointercancel = () => {drag = null;};
  if (staticViewer) {
    E('refresh').textContent = 'Refresh local model';
    E('refresh').disabled = false;
    E('local-folder-note').hidden = false;
    E('copy-path').hidden = true;
    E('status').textContent = 'Waiting for local files';
    E('local-folder-status').textContent = 'Default folder: outputs/ from the local helper. You can choose another local outputs folder.';
    E('message').textContent = 'Click Refresh local model to use this computer’s default outputs/ folder, or choose a local outputs folder below.';
    (async () => {
      try {
        const directory = await savedOutputDirectory();
        if (directory) {
          localOutputDirectory = directory;
          E('choose-local-folder').textContent = 'Change folder';
          E('local-folder-status').textContent = 'Saved local outputs folder: ' + directory.name;
          const permission = directory.queryPermission ? await directory.queryPermission({mode:'read'}) : 'prompt';
          if (permission === 'granted') {
            E('refresh').disabled = false;
            await refreshLocalFolder();
            return;
          }
          localOutputDirectory = null;
          E('local-folder-status').textContent = 'A saved local outputs folder needs permission again. The page will try the default outputs/ folder first.';
        }
      } catch (error) {
        E('message').textContent = 'Could not restore the saved folder: ' + error.message + ' Choose a local folder or click Refresh local model.';
      }
    })();
  } else {
    E('local-folder-note').hidden = true;
    load();
  }
  window.addEventListener('pagehide',clearLocalObjectUrls);
})();
