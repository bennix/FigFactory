// Each edit receives the preceding result as image 1 and one dedicated reference
// as image 2. Reference roles and image numbers never cross stage boundaries.
export function buildLocalStages({ text, bodyText = text, people, poseImage, posePrompt = '', references = [], face = true, clothing = true, scene = false, clothingPrompt = '', scenePrompt = '', identity = '' }) {
  const count = people.length || 1;
  const countConstraint = `Exactly ${count} ${count === 1 ? 'person' : 'people'} in one continuous image. No duplicates, comparison panels, multiple views or side-by-side copies. 画面必须恰好有 ${count} 个人物，只生成一个完整场景；禁止重复人物、分栏、三联画、前后对比或同一人物多个视角。`;
  const mannequinConstraint = `【真人摄影强制约束】姿态参考是无性别或具象的人体人偶，只作为三维姿态控制草图。必须将其转换为一位自然、完整、有真实皮肤和头发的真人${count === 1 ? '模特' : '人物'}；不保留人偶本身。只生成正面或单一自然视角的一张照片，不得生成三视图、转面图、角色设定表、多姿势展示或多个副本。人体应有自然解剖结构、真实皮肤质感、自然面部和头发，不能是塑料/蜡像/橡胶材质、无面孔假人或 3D 渲染。只保留人偶所表达的姿态、体型比例、人物数量和相对位置；头部和四肢不得复制人偶的僵硬造型。未指定服饰时，为人物穿着合身、完整、不暴露的日常服装。`;
  const stages = [{
    kind: 'body', label: '生成形体', reference: poseImage || null,
    prompt: `${mannequinConstraint}\n${countConstraint}\n${bodyText}\n【第 1 步：生成形体】${poseImage ? '图片 1（<image1>）是当前姿态与体型参考。把其中每个人偶替换为自然真人，只保留姿态、体型比例、相对位置与单一相机视角。忽略并丢弃人偶的脸、光头、肤色、裸露身体、材质和展示形式；不得输出三视图或多个角度。' : '按用户文字生成真人形体与构图。'}\n人物资料：${JSON.stringify(people)}。${posePrompt}\n${countConstraint}`,
  }];
  const preserve = `${countConstraint} 图片 1（<image1>） 是上一步生成的工作图，也是本步唯一构图基础。直接修改图片 1（<image1>），不叠加、拼贴或透明覆盖照片，不添加或重复人物。保持人数、体型比例、身体姿态、机位、画幅及未要求修改的内容。`;
  for (const kind of ['clothing', 'scene', 'face']) {
    if (!({ face, clothing, scene })[kind]) continue;
    for (const reference of references.filter(item => item.kind === kind)) {
      const person = `人偶 ${reference.person}`;
      const instruction = kind === 'face'
        ? `【换脸】图片 2（<image2>） 是${person}的唯一权威身份参考，只用于该人物的脸型、五官、发际线、发型、肤色、年龄感与标志特征。将这些身份特征自然应用到图片 1（<image1>） 中该人物的头部，头部保持正常比例及原有朝向。只修改对应人物，保持其他人物的脸与身份。保留工作图的服装、身体动作与背景；不复制图片 2（<image2>） 的动作、服装、背景或构图。用户身份要求：${identity}`
        : kind === 'clothing'
          ? `【换衣服】把图片 1（<image1>） 中${person}的衣服替换成图片 2（<image2>） 中的服装。图片 2（<image2>） 只提供衣服款式、剪裁、颜色、材质与配饰，服饰参考优先于工作图现有衣着。衣服自然贴合原有身体姿态。保持工作图的脸、发型、身份、体型、动作和背景。不复制图片 2（<image2>） 中人物的脸、身体、姿态或背景。服饰要求：${clothingPrompt}\n总体需求（本步只执行其中的服装要求）：${text}`
          : `Replace the ENTIRE background of <image1> with the environment shown in <image2>. Keep only the people from <image1>, including their pose, proportions, face and clothing. Remove the original studio backdrop and floor. Render the people naturally inside the new environment with matching lighting and contact shadows.\n【换场景】图片 1（<image1>） 只提供人物，图片 2（<image2>） 提供新的完整环境。必须替换旧背景和旧地面，而不是仅改颜色或保留棚拍底色。保持人物身份、衣着、动作、体型与人数；背景、地面、环境布局、光线及阴影均允许改变。忽略图片 2 中的人物。${scenePrompt.trim() ? `本步场景与照明要求：${scenePrompt}` : '忠实采用场景参考中的环境布局、背景元素、材质与照明。'}`;
      const constraints = kind === 'scene' ? `${countConstraint} 输出一张自然完整的环境人像，不叠加、拼贴或透明覆盖照片，不增加或重复人物。场景参考与本步要求优先于工作图的原背景；本步不使用前面形体或服饰步骤的背景约束。` : preserve;
      stages.push({ kind, label: kind === 'face' ? `换脸 · ${person}` : kind === 'clothing' ? `换衣服 · ${person}` : '换场景', reference: reference.url, prompt: `${instruction}\n${constraints}` });
    }
  }
  return stages;
}
