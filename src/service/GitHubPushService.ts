import { createProject, addIssueToProject } from '../push/github/project.push';
import { GitHubIssuePushService } from '../push/github/issue.push';
import { GitHubSprintPushService } from '../push/github/sprint.push';
import { GitHubRoadmapPushService } from '../push/github/roadmap.push';
import { GitHubTokenManager } from './GitHubTokenManager';
import { Project, Issue, Backlog, Team, TimeBox, Roadmap } from '../model/models';
import { getProjectFieldIdByName, setProjectItemField, ensureLabelExists } from '../push/github/githubApi';
import { axiosInstance } from '../util/axiosInstance';
import { createOrEnsureTeam } from '../push/github/team.push';
import { addMemberToTeam } from '../push/github/teamMember.push';
import { GenericRepository } from '../repository/generic.repository';
import { GitHubSyncService } from './GitHubSyncService';

// Serviço para enviar modelos MADE para o GitHub
export class GitHubPushService {
  private issuePushService: GitHubIssuePushService;
  private sprintPushService: GitHubSprintPushService;
  private roadmapPushService: GitHubRoadmapPushService;
  private syncService: GitHubSyncService;
  
  constructor() {
    this.issuePushService = new GitHubIssuePushService(GitHubTokenManager.getInstance().getToken());
    this.sprintPushService = new GitHubSprintPushService(GitHubTokenManager.getInstance().getToken());
    this.roadmapPushService = new GitHubRoadmapPushService(GitHubTokenManager.getInstance().getToken());
    this.syncService = new GitHubSyncService();
  }

  // Cria um projeto no GitHub a partir do modelo MADE Project
  async pushProject(org: string, project: Project): Promise<string> {
    
    // Verifica se o projeto já foi processado para este org específico
    const projectRepo = new GenericRepository<any>('./data/db', 'processed_projects.json');
    
    // Cria o projeto no GitHub
    const projectId = await createProject(org, project.name);
    
    return projectId;
  }

  // Cria uma issue no GitHub a partir do modelo MADE Issue e adiciona ao projeto
  async pushIssue(
    org: string,
    repo: string,
    projectId: string,
    issue: Issue,
    allTasks: Issue[] = [],
    allStories: Issue[] = [],
    taskResults: { issueId: string, issueNumber: number }[] = [],
    storyResults: { issueId: string, issueNumber: number }[] = []
  ): Promise<{ issueId: string; issueNumber: number; projectItemId: string }> {
    try {
      // Validate issue before processing
      this.validateIssue(issue);
      
      // Verifica se a issue já foi processada para este org/repo/projeto específico
      const issueRepo = new GenericRepository<any>('./data/db', 'processed_issues.json');
      
      const assignees = this.issuePushService.getAssigneesForIssue(issue);
      let created;
      
      if (issue.type === 'Epic') {
        created = await this.issuePushService.createIssue(org, repo, issue, assignees, [], allStories, [], storyResults);
      } else if (issue.type === 'Feature' || issue.type === 'Story') {
        created = await this.issuePushService.createIssue(org, repo, issue, assignees, allTasks, [], taskResults, []);
      } else {
        created = await this.issuePushService.createIssue(org, repo, issue, assignees);
      }

      const projectItemId = await addIssueToProject(projectId, created.id);

      if (issue.type) {
        try {
          const typeFieldId = await getProjectFieldIdByName(projectId, 'Type');
          if (typeFieldId) {
            await setProjectItemField(projectId, projectItemId, typeFieldId, issue.type);
          }
        } catch (error: any) {
          console.warn(`⚠️ Falha ao definir campo 'Type': ${error.message}`);
        }
      }

      if (issue.backlog) {
        try {
          const backlogFieldId = await getProjectFieldIdByName(projectId, 'Backlog');
          if (backlogFieldId) {
            await setProjectItemField(projectId, projectItemId, backlogFieldId, issue.backlog);
          }
        } catch (error: any) {
          console.warn(`⚠️ Falha ao definir campo 'Backlog': ${error.message}`);
        }
      }
      
      // Add the successfully created issue to the processed issues repository
      const processedIssueRepo = new GenericRepository<any>('./data/db', 'processed_issues.json');
      await processedIssueRepo.add({
        id: created.id,
        title: created.title || issue.title,
        number: created.number,
        uniqueKey: `${org}/${repo}/${created.id}`,
        org,
        repo,
        processedAt: new Date().toISOString()
      });
      
      return {
        issueId: created.id,
        issueNumber: created.number,
        projectItemId
      };
    } catch (error: any) {
      console.error(`❌ Erro ao processar issue ${issue.title || issue.id}:`, {
        error: error.message,
        issueId: issue.id,
        issueType: issue.type
      });
      throw error;
    }
  }

  // Exemplo: envia um projeto e suas issues
  async pushProjectWithIssues(
    org: string,
    repo: string,
    project: Project,
    issues: Issue[],
    allTasks: Issue[] = []
  ): Promise<{ issueId: string; issueNumber: number; projectItemId: string }[]> {
    const projectId = await this.pushProject(org, project);
    const results: { issueId: string; issueNumber: number; projectItemId: string }[] = [];
    for (const issue of issues) {
      const result = await this.pushIssue(
        org,
        repo,
        projectId,
        issue,
        allTasks,
        [],
        [],
        []
      );
      results.push(result);
    }
    return results;
  }

  // Normaliza e valida issues
  public prepareIssues(issues: any[], type: string) {
    for (const issue of issues) {
      issue.type = this.normalizeType(type);
      this.validateIssue(issue);
    }
  }

  // Normaliza o campo type
  private normalizeType(type: string): string {
    if (!type) return '';
    const t = type.toLowerCase();
    if (t === 'epic') return 'Epic';
    if (t === 'feature' || t === 'story') return 'Feature';
    if (t === 'task') return 'Task';
    return type;
  }

  // Valida campos obrigatórios
  private validateIssue(issue: any) {
    if (!issue.title) throw new Error(`Issue sem título detectada: ${JSON.stringify(issue)}`);
    if (!issue.id) throw new Error(`Issue sem id detectada: ${JSON.stringify(issue)}`);
  }

  // Cria issues no GitHub
  public async pushIssues(org: string, repo: string, project: any, issues: any[], allTasks: Issue[] = []) {
    return await this.pushProjectWithIssues(org, repo, project, issues, allTasks);
  }

  // Mapeia id MADE -> issueNumber GitHub
  public mapIdToGitHubNumber(issues: any[], results: any[]) {
    const map = new Map<string, number>();
    issues.forEach((issue, idx) => {
      if (issue.id && results[idx]) {
        map.set(issue.id, results[idx].issueNumber);
      }
    });
    return map;
  }

  // Relaciona tasks com suas stories
  public async linkTasksToStories(
    org: string,
    repo: string,
    tasks: any[],
    taskResults: any[],
    storyIdToGitHubNumber: Map<string, number>
  ) {
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const taskResult = taskResults[i];
      const depends = Array.isArray(task.depends) ? task.depends : [];
      const storyDep = depends.find(dep => storyIdToGitHubNumber.has(dep.id));
      if (storyDep) {
        const storyGitHubNumber = storyIdToGitHubNumber.get(storyDep.id)!;
        try {
          await this.linkIssues(
            org,
            repo,
            taskResult.issueNumber,
            storyGitHubNumber,
            'blocks'
          );
        } catch {}
      }
    }
  }

  // Relaciona stories com suas epics
  public async linkStoriesToEpics(
    org: string,
    repo: string,
    stories: any[],
    storyIdToGitHubNumber: Map<string, number>,
    epicIdToGitHubNumber: Map<string, number>
  ) {
    for (let i = 0; i < stories.length; i++) {
      const story = stories[i];
      const depends = Array.isArray(story.depends) ? story.depends : [];
      const epicDep = depends.find(dep => epicIdToGitHubNumber.has(dep.id));
      if (epicDep) {
        const epicGitHubNumber = epicIdToGitHubNumber.get(epicDep.id)!;
        const storyGitHubNumber = storyIdToGitHubNumber.get(story.id)!;
        try {
          await this.linkIssues(
            org,
            repo,
            storyGitHubNumber,
            epicGitHubNumber,
            'blocks'
          );
        } catch {}
      }
    }
  }

  // Relaciona duas issues (ex: task -> story)
  async linkIssues(
    organizationName: string,
    repositoryName: string,
    parentIssueNumber: number,
    childIssueNumber: number,
    relation: 'blocks' | 'is blocked by' | 'relates to' = 'blocks'
  ): Promise<void> {
    const url = `https://api.github.com/repos/${organizationName}/${repositoryName}/issues/${childIssueNumber}/comments`;
    let body = '';
    if (relation === 'blocks') {
      body = `Depende de #${parentIssueNumber}`;
    } else if (relation === 'is blocked by') {
      body = `Bloqueado por #${parentIssueNumber}`;
    } else {
      body = `Relacionado a #${parentIssueNumber}`;
    }
    const axios_instance = axiosInstance(GitHubTokenManager.getInstance().getToken());
    await axios_instance.post(url, { body });
  }

  public async fullPush(
    org: string,
    repo: string,
    project: Project,
    epics: Issue[],
    stories: Issue[],
    tasks: Issue[],
    backlogs?: Backlog[],
    teams?: Team[],
    timeboxes?: TimeBox[],
    roadmaps?: Roadmap[]
  ) {
    // Cria as labels necessárias ANTES de processar qualquer coisa
    console.log('🏷️ Criando labels necessárias...');
    await this.ensureLabels(org, repo, backlogs, timeboxes, roadmaps);
    
    // Sincroniza o cache local antes de fazer push
    // Nota: Não abortar se a sincronização falhar - projeto pode ser novo
    try {
      await this.syncService.syncFromGitHub(org, project.name);
    } catch (error: any) {
      console.warn(`⚠️ Sincronização falhou (projeto pode ser novo): ${error.message}`);
    }
    
    // Filtra apenas os itens que ainda não existem no GitHub (por título)
    const newEpics = await this.syncService.filterNewIssues(epics);
    const newStories = await this.syncService.filterNewIssues(stories);
    const newTasks = await this.syncService.filterNewIssues(tasks);
    let newTimeboxes: TimeBox[] = [];
    if (timeboxes) {
      newTimeboxes = await this.syncService.filterNewSprints(timeboxes);
    }

    // Adiciona teams antes do restante do fluxo
    if (teams && teams.length > 0) {
      const teamRepo = new GenericRepository<any>('./data/db', 'processed_teams.json');
      
      for (const team of teams) {
        // Cria um identificador único baseado no org/team para evitar duplicação
        const uniqueKey = `${org}/${team.id}`;
        
        // Verifica se o team já foi processado para este org específico
        if (teamRepo.exists(t => t.uniqueKey === uniqueKey)) {
          console.log(`[GitHubPushService] Team ${team.id} já processado para ${org}. Ignorando envio.`);
          continue;
        }
        
        await createOrEnsureTeam(org, team.name, team.description);
        if (team.teamMembers && team.teamMembers.length > 0) {
          for (const member of team.teamMembers) {
            if (member.name) {
              await addMemberToTeam(org, team.name, member.name);
            }
          }
        }
      }
    }

    // Normaliza e valida issues
    this.prepareIssues(newTasks, 'Task');
    this.prepareIssues(newStories, 'Feature');
    this.prepareIssues(newEpics, 'Epic');
    const projectId = await this.pushProject(org, project);

    // 1. Crie Tasks primeiro (são as folhas da árvore de dependências)
    const taskResults = newTasks.length > 0
      ? await this.processIssuesInBatches(org, repo, projectId, newTasks, [], [], [], [])
      : [];
    const taskIdToGitHubId = new Map<string, string>();
    const taskIdToGitHubNumber = new Map<string, number>();
    newTasks.forEach((task, idx) => {
      if (task.id && taskResults[idx]) {
        taskIdToGitHubId.set(task.id, taskResults[idx].issueId);
        taskIdToGitHubNumber.set(task.id, taskResults[idx].issueNumber);
      }
    });
    const storyResults = newStories.length > 0
      ? await this.processIssuesInBatches(org, repo, projectId, newStories, newTasks, [], taskResults, [])
      : [];
    const storyIdToGitHubId = new Map<string, string>();
    const storyIdToGitHubNumber = new Map<string, number>();
    newStories.forEach((story, idx) => {
      if (story.id && storyResults[idx]) {
        storyIdToGitHubId.set(story.id, storyResults[idx].issueId);
        storyIdToGitHubNumber.set(story.id, storyResults[idx].issueNumber);
      }
    });
    const epicResults = newEpics.length > 0
      ? await this.processIssuesInBatches(org, repo, projectId, newEpics, [], newStories, [], storyResults)
      : [];
    const epicIdToGitHubId = new Map<string, string>();
    const epicIdToGitHubNumber = new Map<string, number>();
    newEpics.forEach((epic, idx) => {
      if (epic.id && epicResults[idx]) {
        epicIdToGitHubId.set(epic.id, epicResults[idx].issueId);
        epicIdToGitHubNumber.set(epic.id, epicResults[idx].issueNumber);
      }
    });
    await this.linkTasksToStories(org, repo, newTasks, taskResults, storyIdToGitHubNumber);
    await this.linkStoriesToEpics(org, repo, newStories, storyIdToGitHubNumber, epicIdToGitHubNumber);
    if (roadmaps && roadmaps.length > 0) {
      await this.processRoadmaps(org, repo, roadmaps);
    }
    if (newTimeboxes && newTimeboxes.length > 0) {
      await this.processTimeboxes(org, repo, projectId, newTimeboxes, newTasks, taskIdToGitHubNumber);
    }
  }

  /**
   * Processa timeboxes (sprints) criando as issues de sprint usando REST API
   */
  public async processTimeboxes(
    org: string,
    repo: string,
    projectId: string,
    timeboxes: TimeBox[],
    allTasks: Issue[],
    taskIdToGitHubNumber: Map<string, number>
  ) {
    const timeboxRepo = new GenericRepository<any>('./data/db', 'processed_timeboxes.json');
    
    for (const timebox of timeboxes) {
      try {
        
        // Obter as tasks relacionadas a esta sprint
        const relatedTasks = timebox.sprintItems
          ? timebox.sprintItems.map(item => item.issue)
          : [];

        // Criar array de resultados das tasks para referência
        const taskResults = relatedTasks
          .map(task => {
            const taskNumber = taskIdToGitHubNumber.get(task.id);
            return taskNumber ? { issueId: task.id, issueNumber: taskNumber } : null;
          })
          .filter(result => result !== null) as { issueId: string, issueNumber: number }[];

        // Criar a issue de sprint usando a nova implementação REST
        const sprintResult = await this.sprintPushService.createSprintIssue(
          org,
          repo,
          timebox,
          relatedTasks,
          taskResults
        );

        // Adicionar labels de sprint às tasks relacionadas
        const taskNumbers = taskResults.map(result => result.issueNumber);
        if (taskNumbers.length > 0) {
          await this.sprintPushService.addSprintLabelsToTasks(
            org,
            repo,
            timebox.name,
            taskNumbers
          );
        }

      } catch (error: any) {
        console.error(`❌ Erro ao processar timebox "${timebox.name}":`, error.message);
        // Não interrompe o processo para outras sprints
        continue;
      }
    }

    console.log(`🎉 Processamento de timeboxes concluído!`);
  }

  /**
   * Processa roadmaps criando milestones e labels correspondentes
   */
  public async processRoadmaps(
    org: string,
    repo: string,
    roadmaps: Roadmap[]
  ) {
    for (const roadmap of roadmaps) {
      try {
        
        // Criar labels específicas do roadmap
        await this.roadmapPushService.createRoadmapLabels(org, repo, roadmap);

        // Criar milestones do roadmap
        const roadmapResult = await this.roadmapPushService.createRoadmap(org, repo, roadmap);

      } catch (error: any) {
        console.error(`❌ Erro ao processar roadmap "${roadmap.name}":`, error.message);
        // Não interrompe o processo para outros roadmaps
        continue;
      }
    }
  }

  public async ensureLabels(org: string, repo: string, backlogs?: Backlog[], timeboxes?: TimeBox[], roadmaps?: Roadmap[]) {
    await ensureLabelExists(org, repo, { name: 'Feature', color: '1d76db', description: 'Funcionalidade' });
    await ensureLabelExists(org, repo, { name: 'Task', color: 'cccccc', description: 'Tarefa' });
    await ensureLabelExists(org, repo, { name: 'Epic', color: '5319e7', description: 'Epic' });

    // Cria uma label para cada backlog, se houver
    if (backlogs && backlogs.length > 0) {
      for (const backlog of backlogs) {
        await ensureLabelExists(org, repo, { name: backlog.name, color: 'ededed', description: `Backlog: ${backlog.description || ''}` });
      }
    }

    // Cria labels para as sprints/timeboxes, se houver
    if (timeboxes && timeboxes.length > 0) {
      for (const timebox of timeboxes) {
        // Label do nome da sprint
        await ensureLabelExists(org, repo, { 
          name: `sprint: ${timebox.name}`, 
          color: '0052CC', 
          description: `Sprint ${timebox.name}` 
        });

        // Label do status da sprint
        const statusColors: { [key: string]: string } = {
          'PLANNED': 'FEF2C0',
          'IN_PROGRESS': '0E8A16',
          'CLOSED': '5319E7'
        };
        
        await ensureLabelExists(org, repo, { 
          name: `status: ${timebox.status || 'PLANNED'}`, 
          color: statusColors[timebox.status || 'PLANNED'] || 'CCCCCC', 
          description: `Status: ${timebox.status || 'PLANNED'}` 
        });
      }
      
      // Label genérica para tipo sprint
      await ensureLabelExists(org, repo, { name: 'type: sprint', color: 'B60205', description: 'Sprint issue type' });
    }

    // Cria labels para roadmaps, se houver
    if (roadmaps && roadmaps.length > 0) {
      // Labels genéricas para roadmap
      await ensureLabelExists(org, repo, { name: 'type: roadmap', color: '8B5CF6', description: 'Roadmap' });
      await ensureLabelExists(org, repo, { name: 'type: milestone', color: '6366F1', description: 'Milestone' });
      
      for (const roadmap of roadmaps) {
        // Chama o serviço específico para criar todas as labels do roadmap
        await this.roadmapPushService.createRoadmapLabels(org, repo, roadmap);
      }
    }
  }

  /**
   * Processa issues em batches para reduzir sobrecarga na API
   */
  private async processIssuesInBatches(
    org: string,
    repo: string,
    projectId: string,
    issues: Issue[],
    allTasks: Issue[] = [],
    allStories: Issue[] = [],
    taskResults: { issueId: string, issueNumber: number }[] = [],
    storyResults: { issueId: string, issueNumber: number }[] = [],
    batchSize: number = 3 // Reduzir tamanho do batch
  ): Promise<{ issueId: string; issueNumber: number; projectItemId: string }[]> {
    const results: { issueId: string; issueNumber: number; projectItemId: string }[] = [];
    
    for (let i = 0; i < issues.length; i += batchSize) {
      const batch = issues.slice(i, i + batchSize);
      
      try {
        const batchResults = await Promise.all(
          batch.map(issue => this.pushIssue(org, repo, projectId, issue, allTasks, allStories, taskResults, storyResults))
        );
        results.push(...batchResults);
        
        // Delay entre batches para evitar rate limiting
        if (i + batchSize < issues.length) {
          const delay = 1000; // 1 segundo entre batches
          console.log(`⏳ Aguardando ${delay}ms antes do próximo batch...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        
      } catch (error: any) {
        console.error(`❌ Erro no batch ${Math.floor(i / batchSize) + 1}:`, error.message);
        
        // Tentar processar individualmente em caso de erro no batch
        console.log(`🔄 Tentando processar issues individualmente...`);
        for (const issue of batch) {
          try {
            const result = await this.pushIssue(org, repo, projectId, issue, allTasks, allStories, taskResults, storyResults);
            results.push(result);
            
            // Delay entre issues individuais
            await new Promise(resolve => setTimeout(resolve, 500));
          } catch (individualError: any) {
            console.error(`❌ Falha ao processar issue individual ${issue.title || issue.id}:`, individualError.message);
            // Continuar com as outras issues
          }
        }
      }
    }
    
    console.log(`✅ Processamento concluído: ${results.length}/${issues.length} issues processadas com sucesso`);
    return results;
  }
}